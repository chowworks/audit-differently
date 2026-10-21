import type { StaffInput, StaffInputProblem } from '@ad/types'

/** A pasted person: a name and, optionally, a role. Nothing else is kept (no employee number; owner, 2026-10-18). */
export interface PastedRow {
  name: string
  role: string
}

/** What a paste made: the people, the rows left out for having no name, and the columns not used. */
export interface StaffPaste {
  rows: PastedRow[]
  /** 1-based rows of the paste (the heading row counts) that had something in them but no name. */
  skipped: number[]
  /** The headings (or "column 4") of the columns not used. */
  ignored: string[]
}

/**
 * Cells of a pasted table, each line split by tabs (when that line has one, as a spreadsheet pastes) or else commas
 * (as a person types), so the two can be mixed; with spreadsheet quoting: a quoted
 * cell may hold the separator, a line break, or a doubled quote (""). Windows line endings and a byte-order mark are
 * fine; cells are trimmed and inner runs of spaces made one.
 */
export function splitCells(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, '')
  // The separator of the line starting at `at`: a tab when the line has one, else a comma.
  const sepAt = (at: number) => {
    const end = body.slice(at).search(/\r?\n/)
    return body.slice(at, end < 0 ? undefined : at + end).includes('\t') ? '\t' : ','
  }
  let sep = sepAt(0)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const endCell = () => {
    row.push(cell.replace(/\s+/g, ' ').trim())
    cell = ''
  }
  while (i < body.length) {
    const c = body[i]!
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"'
        i += 2
        continue
      }
      if (c === '"') quoted = false
      else cell += c
      i++
      continue
    }
    if (c === '"' && !cell.trim()) {
      cell = ''
      quoted = true
    } else if (c === sep) endCell()
    else if (c === '\r' || c === '\n') {
      endCell()
      rows.push(row)
      row = []
      if (c === '\r' && body[i + 1] === '\n') i++
      sep = sepAt(i + 1)
    } else cell += c
    i++
  }
  if (cell || row.length) {
    endCell()
    rows.push(row)
  }
  return rows
}

/** The headings a spreadsheet uses for each column, any case, in any order. */
const HEADINGS: Record<keyof PastedRow, string[]> = {
  name: ['name', 'employee name', 'full name', 'staff name', 'employee', 'staff member'],
  role: ['role', 'title', 'position', 'job title'],
}
const headingOf = (cell: string) =>
  cell
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .replace(/\s*#\s*/g, ' #')
    .trim()
const fieldOf = (cell: string) =>
  (Object.keys(HEADINGS) as (keyof PastedRow)[]).find((f) => HEADINGS[f].includes(headingOf(cell)))

/**
 * Pasted rows from a spreadsheet, one person each. A first row of headings (name and role, in either order and common
 * spellings) says which column is which; without one, the columns are name, then role. Any other column (an employee
 * number, a department) is not used, and is listed as such.
 */
export function readStaffPaste(text: string): StaffPaste {
  const table = splitCells(text)
  const head = table[0] ?? []
  const found = head.map(fieldOf)
  const hasHead = found.includes('name')
  const col: Partial<Record<keyof PastedRow, number>> = hasHead
    ? Object.fromEntries(
        (Object.keys(HEADINGS) as (keyof PastedRow)[])
          .map((f) => [f, found.indexOf(f)] as const)
          .filter(([, at]) => at >= 0)
      )
    : { name: 0, role: 1 }
  const used = new Set(Object.values(col))
  const width = Math.max(0, ...table.map((r) => r.length))
  const ignored: string[] = []
  for (let at = 0; at < width; at++) {
    if (used.has(at)) continue
    // A column nobody filled in (a trailing tab) is not worth a word.
    const data = table.slice(hasHead ? 1 : 0)
    if (!data.some((r) => r[at])) continue
    ignored.push((hasHead && head[at]) || `column ${at + 1}`)
  }
  const rows: PastedRow[] = []
  const skipped: number[] = []
  table.forEach((cells, i) => {
    if (hasHead && i === 0) return
    if (!cells.some(Boolean)) return
    const get = (f: keyof PastedRow) => (col[f] == null ? '' : (cells[col[f]!] ?? ''))
    const name = get('name')
    if (!name) skipped.push(i + 1)
    else rows.push({ name, role: get('role') })
  })
  return { rows, skipped, ignored }
}

/** The people of a paste (see `readStaffPaste`). */
export const parseStaff = (text: string): PastedRow[] => readStaffPaste(text).rows

/** What the paste left out, in one short line; null when nothing was. */
export function leftOutWords(p: StaffPaste): string | null {
  const parts: string[] = []
  if (p.skipped.length)
    parts.push(
      `Skipped ${p.skipped.length === 1 ? `row ${p.skipped[0]}` : `rows ${p.skipped.join(', ')}`}: no name`
    )
  if (p.ignored.length)
    parts.push(`${p.ignored.length === 1 ? 'Column' : 'Columns'} not used: ${p.ignored.join(', ')}`)
  return parts.length ? `${parts.join('. ')}.` : null
}

/**
 * What the screen can tell before the rows go up (the server checks it all again, and more: a participant of the same
 * name): lengths, and a name already on the list or on an earlier row, whatever its case. A name is a person's only key,
 * so the owner tells two people of one name apart. `row` is 1-based, as the server's.
 */
export function checkStaff(
  rows: StaffInput[],
  list: { id: string; name: string }[],
  except?: string
): StaffInputProblem[] {
  const problems: StaffInputProblem[] = []
  const others = list.filter((s) => s.id !== except)
  const key = (n: string) => n.replace(/\s+/g, ' ').trim().toLowerCase()
  rows.forEach((r, i) => {
    const row = i + 1
    const name = (r.name ?? '').replace(/\s+/g, ' ').trim()
    const role = (r.role ?? '').trim()
    const apart = `add something to tell them apart, e.g. ${name} (${role || 'their engagement'})`
    if (!name) problems.push({ row, field: 'name', message: 'The name is missing' })
    else if (name.length > 120)
      problems.push({ row, field: 'name', message: 'The name is over 120 characters' })
    else if (others.some((s) => key(s.name) === key(name)))
      problems.push({ row, field: 'name', message: `Already on the staff list: ${apart}` })
    else {
      const earlier = rows.findIndex((x, j) => j < i && key(x.name ?? '') === key(name))
      if (earlier >= 0)
        problems.push({ row, field: 'name', message: `Also on row ${earlier + 1}: ${apart}` })
    }
    if (role.length > 80)
      problems.push({ row, field: 'role', message: 'The role is over 80 characters' })
  })
  return problems
}

/** A problem's words beside its field: the server's "Row 3: " is the row it already sits on. */
export function besideField(p: StaffInputProblem): string {
  const words = p.message.replace(/^Row \d+: /, '')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The problems a refused add or edit sent back, if its body carries them. */
export function problemsOf(body: unknown): StaffInputProblem[] | null {
  const problems = (body as { problems?: unknown } | null)?.problems
  return Array.isArray(problems) ? (problems as StaffInputProblem[]) : null
}
