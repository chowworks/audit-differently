import type { PageItem } from './statement-lines'
import { dateSpans, highlightsFor } from './highlights'

const run = (str: string, x: number, y: number, w = str.length * 5): PageItem => ({
  page: 1,
  str,
  x,
  y,
  w,
  h: 10,
})
const line = (it: PageItem) => ({
  page: 1,
  text: it.str,
  x: it.x - 2,
  y: it.y - 3,
  width: it.w + 4,
  height: 14,
})
// Fictional: the sample's September pay for Jordan Sample.
const jordan = { name: 'Jordan Sample', amount: 280, start: '2026-09-07', end: '2026-09-20' }

describe('exact-word highlights', () => {
  it('finds the dates written in a run, where they are', () => {
    expect(dateSpans('Pay period 09/07/2026 - 09/20/2026')).toEqual([
      { iso: '2026-09-07', from: 11, to: 21 },
      { iso: '2026-09-20', from: 24, to: 34 },
    ])
  })

  it('boxes the name, the pay period and the gross pay on a pay stub, each on its own words', () => {
    const items = [
      run('PAID TO:', 50, 600),
      run('Jordan Sample', 50, 585),
      run('PAY PERIOD:', 400, 700),
      run('09/07/2026 - 09/20/2026', 400, 685),
      run('GROSS PAY:', 400, 650),
      run('$280.00', 400, 635),
    ]
    const boxes = highlightsFor(jordan, ['name', 'payPeriod', 'amount'], items, null)
    expect(boxes.map((b) => b.text)).toEqual([
      'Jordan',
      'Sample',
      '09/07/2026',
      '09/20/2026',
      '$280.00',
    ])
    // The amount's box covers its run, not the label beside it.
    expect(boxes[4]).toMatchObject({ x: 398.5, width: 38 })
  })

  it('highlights a timesheet row once, not again for the name and dates inside it', () => {
    const row = run('Jordan Sample | 09/07/2026 | 09/20/2026 | $280.00 | 20.0', 50, 500)
    const other = run('Casey Demo | 09/07/2026 | 09/20/2026 | $280.00 | 20.0', 50, 485)
    const boxes = highlightsFor(jordan, ['row', 'name', 'payPeriod'], [other, row], line(row))
    expect(boxes).toEqual([line(row)])
  })

  it("marks a bank line's date and amount, even when the statement leaves the year out", () => {
    const tx = [
      run('01/27', 50, 400),
      run('23,827.25', 120, 400),
      run('Corporate ACH Payroll', 200, 400),
    ]
    const earlier = run('01/13 22,756.94 Corporate ACH Payroll', 50, 420)
    const staff = { name: null, amount: 23827.25, start: '2026-01-27', end: '2026-01-27' }
    const theLine = {
      page: 1,
      text: '01/27 23,827.25 Corporate ACH Payroll',
      x: 48,
      y: 397,
      width: 260,
      height: 14,
    }
    const boxes = highlightsFor(staff, ['date', 'amount'], [earlier, ...tx], theLine)
    expect(boxes.map((b) => b.text)).toEqual(['01/27', '23,827.25'])
  })

  it('takes the pay date from beside or under its label', () => {
    const items = [run('PAY DATE:', 400, 700), run('09/25/2026', 400, 686)]
    expect(highlightsFor(jordan, ['payDate'], items, null).map((b) => b.text)).toEqual([
      '09/25/2026',
    ])
    expect(
      highlightsFor(jordan, ['payDate'], [run('Pay date 09/25/2026', 50, 700)], null).map(
        (b) => b.text
      )
    ).toEqual(['09/25/2026'])
  })

  it('leaves out what it cannot find, and never guesses', () => {
    expect(highlightsFor(jordan, ['name', 'amount'], [run('Nothing here', 50, 700)], null)).toEqual(
      []
    )
  })
})
