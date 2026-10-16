/**
 * Which uploaded payroll document goes with which payroll item, from file names and dates alone (reading a pay
 * stub's own text is a later step). Each rule pre-fills only when exactly one document fits; the person checks
 * every match before it is saved.
 *
 * What the files look like (a payroll provider's exports): a time report named for its pay period
 * ("Time and jobs report - 01.11.26 - 01.24.26"), a register named for the day the run was debited, a few days
 * before the pay date ("01.27.26 payroll register"), and a pay stub named for its pay period and the person
 * ("paystub-…-20260111-20260124-First-Last-emp-no-29").
 */

export interface MatchItem {
  /** A participant's work-experience pay, or a staff payroll line. */
  kind: 'participant' | 'staff'
  /** YYYY-MM-DD: the pay period, or for a staff line its date as both ends. */
  start: string
  end: string
  /** The person, for a participant: matched against a pay stub's file name. */
  name?: string
}

export interface MatchDoc {
  id: string
  kind: string
  fileName: string
}

const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
const daysBetween = (a: string, b: string) => Math.round((day(b) - day(a)) / 86_400_000)
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** Every date a file name holds, in order: 20260111, 2026-01-11, 01.11.26, 01-11-2026, 01_11_26. */
export function datesIn(fileName: string): string[] {
  const out: string[] = []
  const re =
    /(\d{4})(\d{2})(\d{2})|(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2,4})/g
  for (const m of fileName.matchAll(re)) {
    let y: number, mo: number, d: number
    if (m[1]) [y, mo, d] = [+m[1], +m[2]!, +m[3]!]
    else if (m[4]) [y, mo, d] = [+m[4], +m[5]!, +m[6]!]
    else {
      ;[mo, d, y] = [+m[7]!, +m[8]!, +m[9]!]
      if (y < 100) y += 2000
    }
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y < 2100) out.push(iso(y, mo, d))
  }
  return out
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** The one document that fits, or null when none or several do. */
/** A pre-filled match, and whether it was found close (sure) or only once the window was widened (a guess to check). */
export interface Match {
  id: string
  sure: boolean
}

/** What a rule decided and why, in a sentence for the person ("How Auto-Match decided"). */
export interface Decision {
  match: Match | null
  /** The file it picked, if any. */
  file?: string
  why: string
}

/**
 * The windows tried in turn, in days off: close first, then wider. The first window holding exactly one file wins;
 * one holding two or more stops the search (they are equally likely, so the person chooses). Pay often comes up to
 * two weeks and a weekend after its period ends, so a match within 16 days is sure; beyond it, a guess.
 */
const WINDOWS = [7, 16, 45]
const SURE_WITHIN = 16

type Candidate = { id: string; off: number; name: string; how: string }

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const short = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
const periodOf = (item: MatchItem) =>
  item.start === item.end
    ? `the ${short(item.end)} pay date`
    : `${short(item.start)}–${short(item.end)}`

function closest(candidates: Candidate[], none: string): Decision {
  for (const w of WINDOWS) {
    const fit = candidates.filter((c) => c.off <= w)
    if (fit.length > 1)
      return {
        match: null,
        why: `${plural(fit.length, 'file')} fit equally well (within ${w} days): ${fit.map((c) => c.name).join(', ')}. Choose one.`,
      }
    if (fit.length === 1) {
      const sure = w <= SURE_WITHIN
      return {
        match: { id: fit[0]!.id, sure },
        file: fit[0]!.name,
        why: `${cap(fit[0]!.how)}.${sure ? '' : ' Only found once the search widened past two weeks, so check it.'}`,
      }
    }
  }
  return {
    match: null,
    why: candidates.length
      ? `${none} The nearest, ${candidates.sort((a, b) => a.off - b.off)[0]!.name}, is ${plural(candidates[0]!.off, 'day')} off, past the 45-day limit.`
      : none,
  }
}

/** A time report's pay period: the first and last dates in its name. */
const rangeOf = (d: MatchDoc) => {
  const ds = datesIn(d.fileName)
  return ds.length < 2 ? null : ([ds[0]!, ds[ds.length - 1]!] as const)
}

/**
 * A time report for the item. A participant's pay period should lie inside the report's: days off are how far it
 * falls outside. A staff line's date is its pay date: 0 inside the report's period (paid current), else the days
 * since the period ended (paid in arrears, weekly to monthly).
 */
export function decideTimesheet(item: MatchItem, docs: MatchDoc[]): Decision {
  const reports = docs.filter((d) => d.kind === 'timesheet')
  if (!reports.length) return { match: null, why: 'No timesheet in the upload.' }
  const candidates = reports.flatMap((d) => {
    const r = rangeOf(d)
    if (!r) return []
    const [a, b] = r
    // Nobody is paid for a period that has not started: a report beginning after a staff pay date is no candidate.
    if (item.kind === 'staff' && item.end < a) return []
    const inside = a <= item.end && item.end <= b
    const off =
      item.kind === 'participant'
        ? Math.max(0, daysBetween(item.start, a), daysBetween(b, item.end))
        : inside
          ? 0
          : daysBetween(b, item.end)
    const how =
      item.kind === 'participant'
        ? off === 0
          ? `its period, ${short(a)}–${short(b)}, covers ${periodOf(item)}`
          : `its period, ${short(a)}–${short(b)}, misses ${periodOf(item)} by ${plural(off, 'day')}`
        : inside
          ? `${periodOf(item)} falls inside its period, ${short(a)}–${short(b)} (paid current)`
          : `its period, ${short(a)}–${short(b)}, ended ${plural(off, 'day')} before ${periodOf(item)} (paid in arrears)`
    return [{ id: d.id, off, name: d.fileName, how, inside, arrears: !inside && item.end > b }]
  })
  if (!candidates.length)
    return {
      match: null,
      why: 'No timesheet has a pay period in its file name (two dates, like "09.07.2026 - 09.20.2026").',
    }
  // A staff pay date inside one period and soon after another reads both ways (paid current, or in arrears): the
  // person chooses.
  if (
    item.kind === 'staff' &&
    candidates.some((c) => c.inside) &&
    candidates.some((c) => c.arrears && c.off <= SURE_WITHIN)
  )
    return {
      match: null,
      why: `${periodOf(item)} falls inside one timesheet's period and just after another's: paid current or in arrears? Choose one.`,
    }
  return closest(candidates, `No timesheet's period is near ${periodOf(item)}.`)
}

/**
 * A register, dated for the day its run was debited: just after a participant's pay period ends, or just before a
 * staff line's pay date. Days off are the distance from there.
 */
export function decideRegister(item: MatchItem, docs: MatchDoc[]): Decision {
  const regs = docs.filter((d) => d.kind === 'payroll-register')
  if (!regs.length) return { match: null, why: 'No payroll register in the upload.' }
  let after = 0
  const candidates = regs.flatMap((d) => {
    const ds = datesIn(d.fileName)
    if (ds.length === 0) return []
    const on = ds[ds.length - 1]!
    // A run is debited before its pay date, never after it.
    if (item.kind === 'staff' && on > item.end) {
      after++
      return []
    }
    const off = Math.abs(daysBetween(item.end, on))
    const how =
      item.kind === 'participant'
        ? `dated ${short(on)}, ${plural(off, 'day')} ${on >= item.end ? 'after' : 'before'} the pay period ended`
        : `dated ${short(on)}, ${plural(off, 'day')} before ${periodOf(item)}`
    return [{ id: d.id, off, name: d.fileName, how }]
  })
  if (!candidates.length)
    return {
      match: null,
      why: after
        ? `Every register is dated after ${periodOf(item)}, and a run is debited before it is paid.`
        : 'No payroll register has a date in its file name.',
    }
  return closest(candidates, `No register is dated near ${periodOf(item)}.`)
}

/** A participant's pay stub: its name holds the pay period exactly and every word of the person's name. Sure or none. */
export function decideStub(item: MatchItem, docs: MatchDoc[]): Decision {
  if (item.kind !== 'participant' || !item.name)
    return { match: null, why: 'Staff pay is proved by its bank statement line, not a stub.' }
  const stubs = docs.filter((d) => d.kind === 'paystub')
  if (!stubs.length) return { match: null, why: 'No pay stub in the upload.' }
  const want = words(item.name)
  const named = stubs.filter((d) => {
    const have = new Set(words(d.fileName))
    return want.every((w) => have.has(w))
  })
  const fit = named.filter((d) => {
    const ds = datesIn(d.fileName)
    return ds.includes(item.start) && ds.includes(item.end)
  })
  if (fit.length === 1)
    return {
      match: { id: fit[0]!.id, sure: true },
      file: fit[0]!.fileName,
      why: `Its name holds "${item.name}" and the pay period ${periodOf(item)}.`,
    }
  if (fit.length > 1)
    return {
      match: null,
      why: `${plural(fit.length, 'stub')} name ${item.name} and ${periodOf(item)}: ${fit.map((d) => d.fileName).join(', ')}. Choose one.`,
    }
  return {
    match: null,
    why: named.length
      ? `${plural(named.length, 'stub')} name ${item.name}, but none has the pay period ${periodOf(item)} in its file name.`
      : `No stub's file name holds "${item.name}".`,
  }
}

export const timesheetFor = (item: MatchItem, docs: MatchDoc[]) => decideTimesheet(item, docs).match
export const registerFor = (item: MatchItem, docs: MatchDoc[]) => decideRegister(item, docs).match
export const stubFor = (item: MatchItem, docs: MatchDoc[]) => decideStub(item, docs).match
