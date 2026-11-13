import { describe, expect, it } from 'vitest'
import { sortPayrollZip } from './zip-files'

/** The payroll zip with the expenses' files too (owner's decision, 2026-11-09). Fictional names. */
const f = (path: string) => ({ path, file: new File(['x'], path.split('/').pop()!) })

describe("the payroll zip's expenses folders", () => {
  it('takes the bank and card statements in one folder, and the books export, by their names', () => {
    const { files, problems } = sortPayrollZip(
      [
        f('Timesheets/t.pdf'),
        f('Payroll registers/r.pdf'),
        f('Bank & card statements/bank.pdf'),
        f('Bank & card statements/card.pdf'),
        f('QuickBooks transactions/books.xlsx'),
      ],
      []
    )
    expect(problems).toEqual([])
    expect(files.map((x) => [x.folder, x.kind, x.file.name])).toEqual([
      ['Timesheets', 'timesheet', 't.pdf'],
      ['Payroll registers', 'payroll-register', 'r.pdf'],
      ['Bank & card statements', 'bank-statement', 'bank.pdf'],
      ['Bank & card statements', 'bank-statement', 'card.pdf'],
      ['QuickBooks transactions', 'payroll-details', 'books.xlsx'],
    ])
  })

  it('still opens a zip made with the old names', () => {
    const { files, problems } = sortPayrollZip(
      [
        f('Timesheets/t.pdf'),
        f('Payroll registers/r.pdf'),
        f('Bank statements/b.pdf'),
        f('Payroll details/books.xlsx'),
      ],
      []
    )
    expect(problems).toEqual([])
    expect(files.map((x) => [x.folder, x.kind])).toEqual([
      ['Timesheets', 'timesheet'],
      ['Payroll registers', 'payroll-register'],
      ['Bank & card statements', 'bank-statement'],
      ['QuickBooks transactions', 'payroll-details'],
    ])
  })

  it('gives the Account mapping files back apart: they are not proof', () => {
    const { files, mappings, names, problems } = sortPayrollZip(
      [
        f('Timesheets/t.pdf'),
        f('Payroll registers/r.pdf'),
        f('Bank statements/b.pdf'),
        f('Account mapping/Youth mapping.xlsx'),
        f('Account mapping/Adult mapping.csv'),
      ],
      []
    )
    expect(problems).toEqual([])
    expect(files).toHaveLength(3)
    expect(names).toEqual([])
    expect(mappings.map((m) => m.name)).toEqual(['Youth mapping.xlsx', 'Adult mapping.csv'])
  })

  it('takes only a sheet or a CSV in Account mapping', () => {
    const { problems } = sortPayrollZip(
      [
        f('Timesheets/t.pdf'),
        f('Payroll registers/r.pdf'),
        f('Bank statements/b.pdf'),
        f('Account mapping/scan.pdf'),
      ],
      []
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('Account mapping/scan.pdf')
  })

  it("gives the Receipts files back apart: the books' bills' receipts, not payroll proof (owner's decision, 2026-11-12)", () => {
    const { files, receipts, problems } = sortPayrollZip(
      [
        f('Timesheets/t.pdf'),
        f('Payroll registers/r.pdf'),
        f('Bank & card statements/b.pdf'),
        f('Receipts/Pixel Tools.pdf'),
        f('Receipts/rent.jpg'),
      ],
      []
    )
    expect(problems).toEqual([])
    expect(files).toHaveLength(3)
    expect(receipts.map((x) => x.name)).toEqual(['Pixel Tools.pdf', 'rent.jpg'])
    // A spreadsheet is no receipt: the payroll company's billing report stays out (owner's decision, 2026-11-12).
    expect(
      sortPayrollZip(
        [
          f('Timesheets/t.pdf'),
          f('Payroll registers/r.pdf'),
          f('Bank & card statements/b.pdf'),
          f('Receipts/billing.csv'),
        ],
        []
      ).problems
    ).toHaveLength(1)
  })
})
