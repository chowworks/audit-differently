import type { StatementLine } from '@ad/types'
import { payrollAiAvailable, payrollAiBeta, promptFor, verify } from './ai-read-payroll'

/** Lines one under the other. Fictional people and pay. */
const lines = (...texts: string[]): StatementLine[] =>
  texts.map((text, i) => ({ page: 1, text, x: 50, y: 700 - i * 15, width: 300, height: 12 }))

const stub = lines(
  'EARNINGS STATEMENT',
  'PAY PERIOD:',
  'Exampletown, DE 19700 01/11/2026 - 01/24/2026',
  'PAY DATE:',
  '01/30/2026',
  'PAID TO:',
  'Casey Rae Demo',
  'Gross Pay 280.00 840.00'
)
const names = ['Jordan "Casey" Demo', 'Morgan Lee']

describe('reading a payroll file with AI', () => {
  it('asks a lookup with our names, and nothing else of ours', () => {
    const q = promptFor('paystub', names)
    expect(q).toContain('- Jordan "Casey" Demo')
    expect(q).toContain('- Morgan Lee')
    expect(q).toContain('Never guess a value.')
  })

  it('keeps a value only where the file shows it, and the line it is on', () => {
    const facts = verify(
      {
        payDate: '2026-01-30',
        periodStart: '2026-01-11',
        periodEnd: '2026-01-24',
        totals: [],
        people: [
          {
            name: 'Jordan "Casey" Demo',
            printedName: 'Casey Rae Demo',
            gross: 280,
            quote: 'Gross Pay 280.00',
          },
        ],
      },
      stub,
      names
    )
    expect(facts).toMatchObject({ payDate: '2026-01-30', start: '2026-01-11', end: '2026-01-24' })
    expect(facts.people).toHaveLength(1)
    expect(facts.people[0]).toMatchObject({ name: 'Jordan "Casey" Demo', gross: 280 })
    expect(facts.people[0]!.line.text).toBe('Gross Pay 280.00 840.00')
    expect(facts.note).toBeUndefined()
  })

  it('drops what the file does not show: an amount, a date, a name it does not print, a name off our lists', () => {
    const facts = verify(
      {
        payDate: '2026-01-31',
        periodStart: '2026-01-11',
        periodEnd: '2026-01-25',
        totals: [9999.99],
        people: [
          { name: 'Jordan "Casey" Demo', printedName: 'Casey Rae Demo', gross: 300 },
          { name: 'Morgan Lee', printedName: 'Morgan Lee', gross: 280 },
          { name: 'Avery Stone', printedName: 'Casey Rae Demo', gross: 280 },
        ],
      },
      stub,
      names
    )
    // The start date is printed, so it stays; the rest is not, so it goes.
    expect(facts).toMatchObject({
      payDate: null,
      start: '2026-01-11',
      end: null,
      totals: [],
      people: [],
    })
    expect(
      verify({ people: [{ name: 'Morgan Lee', printedName: 'Morgan Lee', gross: 1 }] }, stub, names)
        .note
    ).toBe('AI found nothing it could show in the file')
  })

  it("never pins one person's pay to another's row when two are paid the same", () => {
    const register = lines(
      'PAYROLL REGISTER  PAY DATE 01/30/2026',
      'Shah, Priya  Gross 500.00',
      'Morgan Lee',
      'Gross 500.00'
    )
    const facts = verify(
      {
        people: [
          // No quote: the row that prints the name is the one kept.
          { name: 'Priya Shah', printedName: 'Shah, Priya', gross: 500 },
          // Printed, but on no line with the amount, and no quote: dropped, never given Priya's row.
          { name: 'Morgan Lee', printedName: 'Morgan Lee', gross: 500 },
        ],
      },
      register,
      ['Priya Shah', 'Morgan Lee']
    )
    expect(facts.people.map((p) => [p.name, p.line.text])).toEqual([
      ['Priya Shah', 'Shah, Priya  Gross 500.00'],
    ])
  })

  it('tells AI to keep a pay only beside its name, and to leave a shared amount out', () => {
    const q = promptFor('payroll-register', names)
    expect(q).toContain('printed on the same line or row as that amount')
    expect(q).toContain(
      'When two people are paid the same amount, or a name is unclear, leave the person out.'
    )
  })

  it('is offered only with a key, and zero data retention declared or the beta on (said so first)', () => {
    expect(payrollAiAvailable({ ANTHROPIC_API_KEY: 'k' })).toBe(false)
    expect(payrollAiAvailable({ PAYROLL_AI_ZDR: 'on' })).toBe(false)
    expect(payrollAiAvailable({ ANTHROPIC_API_KEY: 'k', PAYROLL_AI_ZDR: 'on' })).toBe(true)
    expect(payrollAiAvailable({ ANTHROPIC_API_KEY: 'k', PAYROLL_AI_BETA: 'on' })).toBe(true)
    expect(payrollAiBeta({ PAYROLL_AI_BETA: 'on' })).toBe(true)
    expect(payrollAiBeta({ PAYROLL_AI_ZDR: 'on', PAYROLL_AI_BETA: 'on' })).toBe(false)
  })
})
