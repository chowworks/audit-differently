import Anthropic from '@anthropic-ai/sdk'
import { Logger } from '@nestjs/common'
import { IMPORT_FIELD_LABELS, IMPORT_FIELDS, type ImportColumns } from '@ad/types'

const logger = new Logger('ImportAiGuess')
const MODEL = 'claude-haiku-5-5'

/** Whether this server can use AI at all: ANTHROPIC_API_KEY is set. Even then nothing is sent without a person's yes. */
export const aiConfigured = (env: NodeJS.ProcessEnv = process.env) => !!env.ANTHROPIC_API_KEY

/** Why a call failed, for the log: the status or the kind of failure, never the request (or the key). */
export function aiFailure(e: unknown): string {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'the API did not answer in time'
  if (e instanceof Anthropic.APIConnectionError) return 'the API could not be reached'
  if (e instanceof Anthropic.APIError) return `the API answered ${e.status ?? 'with an error'}`
  return e instanceof Error ? e.message : 'an unknown error'
}

/**
 * Asks Claude which column holds each field, from the column names alone: no row of the file is ever sent. Only when
 * the person asked ("Suggest the mapping with AI") and ANTHROPIC_API_KEY is set; null on any failure, and the person's
 * columns stay as they were. The person confirms the mapping on screen either way.
 */
export async function aiGuessColumns(
  headers: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<ImportColumns | null> {
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  const fields = IMPORT_FIELDS.map((f) => `${f}: ${IMPORT_FIELD_LABELS[f]}`).join('\n')
  const prompt = `An accounting export (for example a QuickBooks transaction report) has these column names:
${JSON.stringify(headers)}

Which column holds each of these fields of an expense line? Use only debit and credit when there is no single amount column. "category" is the expense account or category the spending was coded to (on a QuickBooks register report, "Split").
${fields}

Answer with one JSON object only, each key a field above and each value one of the column names exactly as given. Leave out a field no column holds.`
  try {
    const client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 1 })
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
    })
    const text =
      res.stop_reason === 'end_turn'
        ? res.content.find((c): c is Anthropic.TextBlock => c.type === 'text')?.text
        : undefined
    if (!text) throw new Error(`the answer stopped with ${res.stop_reason}`)
    const json = /\{[\s\S]*\}/.exec(text)?.[0]
    if (!json) throw new Error('no JSON in the answer')
    const raw = JSON.parse(json) as Record<string, unknown>
    const out: ImportColumns = {}
    for (const f of IMPORT_FIELDS) {
      const v = raw[f]
      if (typeof v === 'string' && headers.includes(v)) out[f] = v
    }
    return out.date || out.vendor || out.amount ? out : null
  } catch (e) {
    logger.warn(`The AI guess failed, so the guess from the column names stands: ${aiFailure(e)}`)
    return null
  }
}
