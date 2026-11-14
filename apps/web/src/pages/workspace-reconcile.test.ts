import { describe, expect, it } from 'vitest'
import type {
  CheckDto,
  ExpenseDto,
  PayLineDto,
  PayrollReconciliationDto,
  ReportDetail,
  WexPaymentDto,
} from '@ad/types'
import { NO_ENGAGEMENT, expenseRows, grouped, payrollRows, toneCounts } from './workspace-reconcile'

const doc = (purpose: string) =>
  ({ purpose, document: { id: `d-${purpose}`, kind: 'invoice', fileName: 'f.pdf' } }) as never

const expense = (over: Partial<ExpenseDto>): ExpenseDto =>
  ({
    id: 'e1',
    itemNumber: 'ISY-1',
    reportLine: 'indirect',
    allocationType: 'direct',
    fromBooks: true,
    counts: true,
    documents: [doc('invoice'), doc('payment')],
    tags: [],
    ...over,
  }) as ExpenseDto

const check = (over: Partial<CheckDto>): CheckDto =>
  ({ id: 'k1', code: 'x', severity: 'attention', message: 'Look', ...over }) as CheckDto

const month = (over: Partial<ReportDetail>): ReportDetail =>
  ({
    id: 'rep-1',
    engagement: { id: 'e-ycp', name: 'Youth Coding Pathway' },
    expenses: [],
    wexPayments: [],
    checks: [],
    ...over,
  }) as unknown as ReportDetail

const pay = (over: Partial<PayLineDto>): PayLineDto => ({
  id: 'p1',
  documentId: 'd1',
  fileId: null,
  fileName: 'register.pdf',
  kind: 'payroll-register',
  mark: null,
  state: 'unassigned',
  item: null,
  notFunded: null,
  flags: [],
  staff: null,
  ...over,
})

const recon = (over: Partial<PayrollReconciliationDto>): PayrollReconciliationDto =>
  ({
    workspaceId: 'w',
    period: '2026-09',
    pays: [],
    otherBankLines: 0,
    unproved: [],
    books: [],
    items: [],
    counts: {},
    staffOnNoEngagement: [],
    dropped: [],
    twoProofs: [],
    filesOverLineCap: [],
    can: { change: true },
    ...over,
  }) as PayrollReconciliationDto

describe("the month page's rows", () => {
  const m = month({
    expenses: [
      expense({ id: 'ok' }),
      expense({ id: 'short', documents: [doc('payment')] }),
      expense({ id: 'look' }),
      expense({ id: 'blocked' }),
    ],
    wexPayments: [
      {
        id: 'w1',
        participantId: 'p1',
        documents: [doc('timesheet')],
        tags: [],
      } as unknown as WexPaymentDto,
    ],
    checks: [
      check({ id: 'k1', expenseId: 'look', severity: 'attention' }),
      check({ id: 'k2', expenseId: 'blocked', severity: 'blocker' }),
    ],
  })
  const spent = expenseRows(null, [m])
  const tone = (key: string) => spent.find((r) => r.key === key)?.tone

  it('are red while a proof is missing or a check blocks, yellow on attention, green when neither', () => {
    expect(tone('m-ok')).toBe('green')
    expect(tone('m-short')).toBe('red')
    expect(spent.find((r) => r.key === 'm-short')).toMatchObject({ missing: ['invoice'] })
    expect(tone('m-look')).toBe('yellow')
    expect(tone('m-blocked')).toBe('red')
    expect(spent.every((r) => r.group === 'e-ycp')).toBe(true)
  })

  it('put each participant paid in Payroll & Proof', () => {
    const pays = payrollRows(recon({}), [m])
    expect(pays).toHaveLength(1)
    expect(pays[0]).toMatchObject({ kind: 'month', tone: 'red', missing: ['register', 'payment'] })
  })
})

describe('Expenses & Proof rows on no engagement', () => {
  const line = (key: string, status: string) =>
    ({ key, status, vendor: 'V', description: '', amount: 10 }) as never
  const rows = expenseRows(
    {
      lines: [
        line('billed', 'billed'),
        line('off', 'not-ours'),
        line('gap', 'no-mapping'),
        line('entered', 'already-entered'),
      ],
      receipts: [
        {
          documentId: 'r1',
          fileName: 'loose.pdf',
          amount: 12,
          date: null,
          vendor: null,
          transactionIds: [],
        },
        {
          documentId: 'r2',
          fileName: 'used.pdf',
          amount: 100,
          date: null,
          vendor: null,
          transactionIds: ['9001'],
        },
      ],
    },
    []
  )
  const tone = (key: string) => rows.find((r) => r.key === key)?.tone

  it('lists a receipt matched to no bill, and the books lines on no engagement', () => {
    expect(rows.find((r) => r.key === 'r-r1')).toMatchObject({
      tone: 'yellow',
      group: NO_ENGAGEMENT,
    })
    expect(rows.some((r) => r.key === 'r-r2')).toBe(false)
    expect(tone('o-off')).toBe('green')
    expect(tone('o-gap')).toBe('yellow')
    // A billed line is its month's row (Actions says what is to save); one already entered is on its month too.
    expect(rows.some((r) => r.key.endsWith('billed') || r.key.endsWith('entered'))).toBe(false)
  })
})

describe('Payroll & Proof rows the month page has not', () => {
  const rows = payrollRows(
    recon({
      twoProofs: [
        {
          target: 'expense',
          id: 'two',
          title: 'Expense ISY-13',
          engagementName: 'Youth Coding Pathway',
          reportId: 'rep-1',
          slot: 'register',
          message: 'Two registers differ',
        },
      ],
      pays: [
        pay({ id: 'matched', state: 'matched' }),
        pay({ id: 'loose' }),
        pay({
          id: 'nf',
          state: 'not-funded',
          notFunded: { reason: 'General funds', by: 'o@x', at: '2026-10-02' },
        }),
      ],
      staffOnNoEngagement: [
        { id: 's1', name: 'Charged', inFiles: true, paid: null, charged: 500 },
        { id: 's2', name: 'Paid', inFiles: true, paid: 400, charged: null },
        { id: 's3', name: 'Neither', inFiles: true, paid: null, charged: null },
      ],
      books: [
        {
          engagementId: 'e-ycp',
          engagementName: 'Youth Coding Pathway',
          reportId: 'rep-1',
          date: '2026-09-30',
          kind: 'staff-pay',
          books: 900,
          files: 1000,
        },
        {
          engagementId: 'e-ycp',
          engagementName: 'Youth Coding Pathway',
          reportId: 'rep-1',
          date: '2026-09-15',
          kind: 'staff-pay',
          books: 800,
          files: 800,
        },
      ],
    }),
    [month({})]
  )
  const tone = (key: string) => rows.find((r) => r.key === key)?.tone

  it('puts two files that disagree on an item in its engagement, yellow', () => {
    expect(rows.find((r) => r.kind === 'two')).toMatchObject({ tone: 'yellow', group: 'e-ycp' })
  })

  it('lists pays on no item to place, and settles the ones marked not grant-funded', () => {
    expect(rows.some((r) => r.key === 'p-matched')).toBe(false)
    expect(tone('p-loose')).toBe('yellow')
    expect(tone('p-nf')).toBe('green')
    expect(tone('s-s1')).toBe('yellow')
    expect(tone('s-s2')).toBe('green')
    expect(rows.some((r) => r.key === 's-s3')).toBe(false)
  })

  it('puts a run whose expenses differ in its engagement, and leaves out runs that agree', () => {
    const runs = rows.filter((r) => r.kind === 'run')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ tone: 'yellow', group: 'e-ycp' })
  })

  it('counts every row once, and groups the engagements before what is on none', () => {
    const c = toneCounts(rows)
    expect(c.red + c.yellow + c.green).toBe(rows.length)
    const groups = grouped(rows, new Map([['e-ycp', 'Youth Coding Pathway']]))
    expect(groups.map((g) => g.id)).toEqual(['e-ycp', NO_ENGAGEMENT])
    expect(groups[0]!.rows.map((r) => r.tone)).toEqual(['yellow', 'yellow'])
  })
})
