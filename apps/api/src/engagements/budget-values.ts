import { BadRequestException } from '@nestjs/common'

/**
 * A budget line's own values, as a row of an uploaded budget file gives them (GitHub issue #98). Each refuses a bad
 * value with a 400 in plain words, which the file's reader keeps as the row's reason.
 */

/** An approved amount: $0 or more, under $10 billion. The file's reader refuses a blank amount before this. */
export function amountOf(given: unknown): string {
  if (given == null || given === '') return '0.00'
  const n = Number(given)
  if (!Number.isFinite(n) || n < 0) throw new BadRequestException('The amount must be $0 or more')
  if (n >= 1e10) throw new BadRequestException('The amount must be under $10,000,000,000')
  return n.toFixed(2)
}

export function narrativeOf(given: unknown): string | null {
  const text = typeof given === 'string' ? given.trim() : ''
  if (text.length > 2000) throw new BadRequestException('Keep the note under 2,000 characters')
  return text || null
}

export function nameOf(given: unknown): string {
  const name = typeof given === 'string' ? given.trim().replace(/\s+/g, ' ') : ''
  if (!name) throw new BadRequestException('Name the budget line as the approved budget does')
  if (name.length > 120) throw new BadRequestException('Keep the name under 120 characters')
  return name
}

/** The message of a 400 that one of these checks throws; anything else is not a value problem and is thrown on. */
export function reasonOf(e: unknown): string {
  if (!(e instanceof BadRequestException)) throw e
  return e.message
}
