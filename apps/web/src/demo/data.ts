/**
 * The interactive demo's story data. Everything here is fictional: the academy, its people, the funder, the
 * vendors and every amount. It is marketing, not the app: nothing is read from or sent to the API except the
 * sign-up on the gate.
 */

export const ORG = 'Northgate Career Academy'
export const GRANT = 'Youth Pathways Grant'
export const FUNDER = 'State Workforce Commission'
export const AWARD = 480_000
export const MONTH = 'November 2026'
/** Months of the 12-month award that have passed at the end of November (July start). */
export const MONTHS_ELAPSED = 5
export const ELAPSED = MONTHS_ELAPSED / 12

export const PEOPLE = {
  ceo: { initials: 'AR', name: 'Angela Ruiz', role: 'CEO', tone: 'navy' },
  books: { initials: 'MB', name: 'Marcus Bell', role: 'Bookkeeper', tone: 'green' },
  monitor: { initials: 'SW', name: 'State monitor', role: 'Funder', tone: 'amber' },
} as const
export type PersonKey = keyof typeof PEOPLE

export interface BudgetLine {
  name: string
  approved: number
  /** Cumulative spending at the end of each month, July to November. */
  monthly: number[]
}

export const BUDGET: BudgetLine[] = [
  {
    name: 'Instructor wages',
    approved: 168_000,
    monthly: [14_600, 30_400, 46_500, 63_000, 79_800],
  },
  {
    name: 'Payroll taxes & benefits',
    approved: 33_600,
    monthly: [2_700, 5_600, 8_500, 11_300, 14_100],
  },
  {
    name: 'Participant stipends',
    approved: 96_000,
    monthly: [3_200, 9_600, 17_600, 26_400, 36_000],
  },
  { name: 'Classroom rent', approved: 48_000, monthly: [4_000, 8_000, 12_000, 16_000, 20_000] },
  { name: 'Training supplies', approved: 38_400, monthly: [6_800, 10_900, 14_600, 18_200, 21_900] },
  { name: 'Transportation', approved: 24_000, monthly: [1_200, 2_900, 4_700, 6_400, 8_200] },
  { name: 'Administration', approved: 72_000, monthly: [6_000, 12_000, 18_000, 24_000, 30_000] },
]

export const spent = (l: BudgetLine) => l.monthly[l.monthly.length - 1]
/** Straight-line projection: this pace, kept up for the rest of the award. */
export const projected = (l: BudgetLine) => Math.round((spent(l) / MONTHS_ELAPSED) * 12)
export type Pace = 'over' | 'on-track' | 'under'
export function paceOf(l: BudgetLine): Pace {
  const ratio = projected(l) / l.approved
  if (ratio > 1.04) return 'over'
  if (ratio < 0.9) return 'under'
  return 'on-track'
}
export const PACE_LABEL: Record<Pace, string> = {
  over: 'Heading over',
  'on-track': 'On track',
  under: 'Under pace',
}

export const UPLOADS = [
  { icon: '📒', file: 'QuickBooks export · Nov 2026.csv', found: '148 transactions' },
  { icon: '🧾', file: 'Payroll register · Nov 2026.pdf', found: '2 pay runs · 14 people' },
  { icon: '🏦', file: 'Bank statement · Nov 2026.pdf', found: '61 bank lines' },
  { icon: '📨', file: 'Receipts (emailed in all month)', found: '37 receipts' },
]

export interface Expense {
  vendor: string
  what: string
  books: number
  line: string
  /** What the proof shows once matched. */
  result: 'ok' | 'missing' | 'differs'
  receipt?: number
  proofs: string[]
}

export const EXPENSES: Expense[] = [
  {
    vendor: 'Metro Transit',
    what: 'Bus passes, 40 riders',
    books: 1_640,
    line: 'Transportation',
    result: 'ok',
    receipt: 1_640,
    proofs: ['Receipt', 'Bank line'],
  },
  {
    vendor: 'Payroll run · Nov 14',
    what: 'Instructor pay, 7 people',
    books: 16_420,
    line: 'Instructor wages',
    result: 'ok',
    proofs: ['Register', 'Timesheets', 'Bank debit'],
  },
  {
    vendor: 'Harbor Office Supply',
    what: 'Workbooks and toner',
    books: 421.5,
    line: 'Training supplies',
    result: 'differs',
    receipt: 412.5,
    proofs: ['Receipt', 'Bank line'],
  },
  {
    vendor: 'Eastside Properties',
    what: 'Classroom rent, November',
    books: 4_000,
    line: 'Classroom rent',
    result: 'ok',
    receipt: 4_000,
    proofs: ['Invoice', 'Bank line'],
  },
  {
    vendor: 'Toolbox Direct',
    what: 'Safety kits, welding cohort',
    books: 1_285,
    line: 'Training supplies',
    result: 'missing',
    proofs: ['Bank line'],
  },
  {
    vendor: 'Payroll run · Nov 28',
    what: 'Participant stipends, 24 people',
    books: 9_600,
    line: 'Participant stipends',
    result: 'ok',
    proofs: ['Register', 'Timesheets', 'Bank debit'],
  },
]

export interface Unallowable {
  vendor: string
  what: string
  amount: number
  rule: string
  cite: string
}

export const UNALLOWABLE: Unallowable[] = [
  {
    vendor: "Bella's Catering",
    what: 'Staff Thanksgiving lunch',
    amount: 640,
    rule: 'Entertainment',
    cite: '2 CFR 200.438 · FAR 31.205-14',
  },
  {
    vendor: 'Corner Market',
    what: 'Wine for the graduation reception',
    amount: 180,
    rule: 'Alcoholic beverages',
    cite: '2 CFR 200.423 · FAR 31.205-51',
  },
  {
    vendor: 'Northgate Rotary',
    what: 'Gala table',
    amount: 250,
    rule: 'Contributions and donations',
    cite: '2 CFR 200.434 · FAR 31.205-8',
  },
  {
    vendor: 'City Water',
    what: 'Late payment fee',
    amount: 35,
    rule: 'Fines and penalties',
    cite: '2 CFR 200.441 · FAR 31.205-15',
  },
]

export const FIXES = [
  { what: 'Attach the Toolbox Direct receipt', how: 'Forwarded from Marcus’s inbox', points: 7 },
  { what: 'Confirm the Harbor Office Supply amount', how: 'Books corrected to $412.50', points: 5 },
  {
    what: 'Move 4 unallowable costs off the grant',
    how: '$1,105 charged to unrestricted funds',
    points: 8,
  },
  { what: 'Add 2 missing instructor timesheets', how: 'Pulled from the payroll zip', points: 6 },
  {
    what: 'Complete Jordan P.’s eligibility file',
    how: 'Proof of age added, locked to owners',
    points: 3,
  },
]
export const READY_START = 71

export const PACKAGE = [
  { folder: '01 Proposal', files: 3 },
  { folder: '02 Award letter', files: 1 },
  { folder: '03 Budget narrative', files: 2 },
  { folder: '04 Contract and approved budget', files: 4 },
  { folder: '05 Participants and eligibility', files: 96, locked: true },
  { folder: '06 Monthly ledger and proof (Jul to Nov)', files: 287 },
  { folder: '07 Signed monthly reports', files: 5 },
  { folder: 'Budget vs actual.csv', files: 1 },
  { folder: 'Index.pdf', files: 1 },
]

export const money = (n: number, cents = false) =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })
