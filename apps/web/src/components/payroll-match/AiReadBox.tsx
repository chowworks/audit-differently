import { useEffect, useRef, useState } from 'react'
import type { PayrollMatchRunDto } from '@ad/types'
import { Button, Modal } from '@/components/ui'
import { useApi } from '@/hooks/useApi'

/** Our AI provider's own page on how long it keeps what an organization sends (owner's decision, 2026-10-19). */
const AI_RETENTION_URL =
  'https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data'

/** How many files one call reads (the server's limit), so the screen can say how far it is. */
export const AI_PER_CALL = 3

/** The files AI may read that it has not read yet: every payroll file read (payroll details as its rows); bank statements never. */
export const aiToRead = (run: PayrollMatchRunDto) =>
  run.files.filter(
    (f) => f.kind !== 'bank-statement' && f.status === 'read' && !run.ai.read.includes(f.id)
  )

/** Whether the server can read payroll files with AI, and whether it is the beta; null until it answers. */
export function usePayrollAi(): { available: boolean; beta: boolean } | null {
  const api = useApi()
  const apiRef = useRef(api)
  const [ai, setAi] = useState<{ available: boolean; beta: boolean } | null>(null)
  useEffect(() => {
    let gone = false
    void apiRef.current
      .get<{ available: boolean; beta: boolean }>('/payroll-ai')
      .then((x) => !gone && setAi(x))
      .catch(() => !gone && setAi({ available: false, beta: false }))
    return () => {
      gone = true
    }
  }, [])
  return ai
}

/**
 * Once an upload's files are read on the server and the person ticked AI on the Upload step (#22): the files are read
 * with AI, a few at a time, and the match is shown after. `reading` holds the match back meanwhile.
 */
export function useAiAfterUpload<R extends PayrollMatchRunDto>({
  run,
  ready,
  on,
  read,
  onRun,
}: {
  run: R | null
  /** The server has read every file. */
  ready: boolean
  /** The person ticked "Read the files with AI". */
  on: boolean
  read: (runId: string, fileIds: string[]) => Promise<R>
  onRun: (run: R) => void
}) {
  const [doneFor, setDoneFor] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef({ run, read, onRun })
  latest.current = { run, read, onRun }
  const runId = run?.id ?? null
  useEffect(() => {
    const r = latest.current.run
    if (!r || !ready || !on || doneFor === r.id) return
    const toRead = aiToRead(r)
    if (!toRead.length) {
      setDoneFor(r.id)
      return
    }
    let gone = false
    void (async () => {
      setError(null)
      setProgress({ done: 0, total: toRead.length })
      try {
        for (let i = 0; i < toRead.length; i += AI_PER_CALL) {
          const next = await latest.current.read(
            r.id,
            toRead.slice(i, i + AI_PER_CALL).map((f) => f.id)
          )
          if (gone) return
          latest.current.onRun(next)
          setProgress({ done: Math.min(i + AI_PER_CALL, toRead.length), total: toRead.length })
        }
      } catch (e) {
        if (!gone) setError((e as Error).message)
      } finally {
        if (!gone) {
          setProgress(null)
          setDoneFor(r.id)
        }
      }
    })()
    return () => {
      gone = true
    }
  }, [runId, ready, on, doneFor])
  const reading = !!runId && ready && on && doneFor !== runId
  return { reading, progress, error }
}

/**
 * "Read the files with AI", a tick-box on the Upload step of both payroll match screens (#22; owner's decisions,
 * 2026-10-19): unticked every time the screen opens, shown only when the server can run it (a key, and our AI provider
 * keeping nothing after it answers, or the beta on: then ticking it first says what may be kept, and for how long). After
 * the upload is read, the files are read with AI and the match uses what AI found, marked ✨, where the file's own text
 * shows it. Payroll details goes as its rows' text; bank statements are never sent.
 */
export function AiReadBox({
  available,
  beta,
  names = 'the names on your staff and participant lists',
  checked,
  onChange,
}: {
  available: boolean
  beta: boolean
  /** Whose names go with the files, in the screen's words. */
  names?: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  /** In beta (no zero data retention yet): the notice the person reads before the box is ticked. */
  const [asking, setAsking] = useState(false)
  if (!available) return null
  return (
    <div className="ad-ai-optin">
      <span className="ad-ai-tag">✨ Optional AI Automation</span>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          onChange={(e) =>
            e.target.checked && beta ? setAsking(true) : onChange(e.target.checked)
          }
        />
        <span>
          <b>Read the payroll files with AI after the upload.</b> The match then uses what AI found,
          marked ✨, where the file&apos;s own text shows it.
        </span>
      </label>
      <small className="text-soft">
        Sends the payroll files as uploaded, pay stubs included, payroll details as its rows, and{' '}
        {names}, each file on its own, to our AI service,{' '}
        {beta
          ? 'which may keep it for up to 30 days while this is in beta.'
          : 'which keeps nothing after it answers.'}{' '}
        Bank statements and anything else of yours are never sent.
      </small>
      {asking && (
        <Modal title="Reading payroll files with AI is in beta" onClose={() => setAsking(false)}>
          <div className="grid gap-4 text-sm">
            <p>
              <b>
                Our AI service may keep what we send for up to 30 days, until zero data retention is
                in place.
              </b>
            </p>
            <ul className="grid list-disc gap-1 pl-5">
              <li>
                Sent: the payroll files as uploaded, pay stubs included (names, pay and what else
                they print), payroll details as its rows, and {names}.
              </li>
              <li>
                Never used to train AI models, see{' '}
                <a href={AI_RETENTION_URL} target="_blank" rel="noreferrer">
                  our AI provider&apos;s data retention policy
                </a>
                .
              </li>
            </ul>
            <p>
              <b>
                Once zero data retention is in place, nothing is kept after AI answers, and this
                notice goes away.
              </b>
            </p>
            <div className="flex justify-end gap-2">
              <Button kind="ghost" onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button
                kind="navy"
                onClick={() => {
                  setAsking(false)
                  onChange(true)
                }}
              >
                Read with AI
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** While the files are read with AI, before the match: how far it is. */
export function AiReadingNote({
  progress,
  error,
}: {
  progress: { done: number; total: number } | null
  error: string | null
}) {
  if (error)
    return (
      <p className="ad-field-error-sum" role="status">
        Reading with AI stopped: {error}. The match below uses what was read.
      </p>
    )
  return (
    <p className="text-sm font-semibold" role="status">
      <span className="ad-hourglass" aria-hidden="true">
        ⏳
      </span>{' '}
      ✨ Reading the files with AI{progress ? `: ${progress.done} of ${progress.total}` : '…'}
    </p>
  )
}
