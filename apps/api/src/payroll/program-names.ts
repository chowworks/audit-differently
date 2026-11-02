import { BadRequestException } from '@nestjs/common'
import {
  MAX_PROGRAM_NAME_LENGTH,
  MAX_PROGRAM_NAMES,
  MAX_PROGRAMS,
  NOT_OURS,
  programKey,
  type ProgramNames,
} from '@ad/types'
import { readGrid } from '../imports/table'

/** Words of a header cell ("Class full name (Column A)", "Payroll project", "Alias 2"), not of a program's own name. */
const HEADER_WORDS =
  /\b(?:column|mapping|names?|class|project|job|books|payroll|accounting|alias(?:es)?|aka)\b/i
/** A header cell that is only a word for the column ("Program", "Programs", "Other name 3"): never a program's name. */
const HEADER_CELL = /^(?:programs?|other names?|alternate names?)\s*\d*$/i
const isHeader = (row: string[]) =>
  row.some((c) => HEADER_WORDS.test(c) || HEADER_CELL.test(c.trim()))

/**
 * A program names file's rows (owner's decision, 2026-11-01): any sheet or CSV whose rows each name one program as the
 * different systems call it (a class list mapped to the payroll company's projects), as many names (columns) as it has,
 * read in memory, never stored. Rows that share a name are one program (`mergeProgramNames`). Its
 * first row is left out when it reads as a header; a cell that is only a note in brackets ("(Leave blank)") is not a
 * name.
 */
export async function programNameRows(buffer: Buffer, fileName: string): Promise<string[][]> {
  const grid = (await readGrid(buffer, fileName)).filter((r) => r.some((c) => c.trim()))
  const rows = grid[0] && isHeader(grid[0]) ? grid.slice(1) : grid
  return rows
    .map((r) =>
      r
        .map((c) => c.trim())
        .filter((c) => c && !/^\(.*\)$/.test(c) && programKey(c))
        .map((c) => c.slice(0, MAX_PROGRAM_NAME_LENGTH))
    )
    .filter((r) => r.length > 0)
}

/** The list an owner sent, checked: each program's names (text, at most so many) and its engagement (one of these). */
export function cleanProgramNames(given: unknown, engagementIds: Set<string>): ProgramNames[] {
  if (!Array.isArray(given)) throw new BadRequestException('Send the list of programs')
  if (given.length > MAX_PROGRAMS)
    throw new BadRequestException(`A workspace keeps up to ${MAX_PROGRAMS} programs`)
  const list: ProgramNames[] = given.map((g: unknown) => {
    const o = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>
    const names = Array.isArray(o.names) ? o.names : []
    if (!names.length) throw new BadRequestException('Each program has at least one name')
    if (names.length > MAX_PROGRAM_NAMES)
      throw new BadRequestException(
        `"${String(names[0]).slice(0, 60)}" has ${names.length} names: a program keeps up to ${MAX_PROGRAM_NAMES}. Rows that share a name are one program.`
      )
    if (
      names.some(
        (n) => typeof n !== 'string' || !programKey(n) || n.length > MAX_PROGRAM_NAME_LENGTH
      )
    )
      throw new BadRequestException(`A name is text of up to ${MAX_PROGRAM_NAME_LENGTH} characters`)
    const engagementId = o.engagementId ?? null
    if (
      engagementId !== null &&
      engagementId !== NOT_OURS &&
      (typeof engagementId !== 'string' || !engagementIds.has(engagementId))
    )
      throw new BadRequestException('A program is linked to an engagement of this workspace only')
    return { names: (names as string[]).map((n) => n.trim()), engagementId }
  })
  // One program per name and per engagement: a second would never be read (`programOf` takes the first).
  const seen = new Set<string>()
  for (const n of list.flatMap((g) => g.names.map(programKey))) {
    if (seen.has(n))
      throw new BadRequestException('A name belongs to one program only: merge the two')
    seen.add(n)
  }
  const linked = list.map((g) => g.engagementId).filter((e) => e !== null && e !== NOT_OURS)
  if (new Set(linked).size !== linked.length)
    throw new BadRequestException('An engagement is linked to one program only')
  return list
}

/**
 * The list as stored, read back: anything that is not a program is left out, and a link to an engagement no longer
 * there (`engagementIds`, when given) is no link.
 */
export const programNamesIn = (stored: unknown, engagementIds?: Set<string>): ProgramNames[] =>
  Array.isArray(stored)
    ? stored
        .filter(
          (g): g is ProgramNames =>
            !!g && typeof g === 'object' && Array.isArray((g as ProgramNames).names)
        )
        .map((g) =>
          engagementIds &&
          g.engagementId &&
          g.engagementId !== NOT_OURS &&
          !engagementIds.has(g.engagementId)
            ? { ...g, engagementId: null }
            : g
        )
    : []
