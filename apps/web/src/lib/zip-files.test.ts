import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { filesFromZip, sortPayrollZip } from './zip-files'

describe('filesFromZip', () => {
  it('opens a zip into its uploadable files, with their folders, and names the rest', async () => {
    const bytes = zipSync({
      'Timesheets/Time report - 10.11.26 - 10.24.26.pdf': strToU8('%PDF-1.7'),
      'Pay stubs/paystub-a.pdf': strToU8('%PDF-1.7'),
      'top.png': strToU8('png'),
      'notes.txt': strToU8('hello'),
      '.DS_Store': strToU8('x'),
      '__MACOSX/Pay stubs/._paystub-a.pdf': strToU8('x'),
    })
    const zip = new File([bytes], 'payroll.zip', { type: 'application/zip' })
    const { files, skipped } = await filesFromZip(zip)
    expect(files.map((f) => [f.folder, f.file.name, f.file.type])).toEqual([
      ['Timesheets', 'Time report - 10.11.26 - 10.24.26.pdf', 'application/pdf'],
      ['Pay stubs', 'paystub-a.pdf', 'application/pdf'],
      ['', 'top.png', 'image/png'],
    ])
    expect(skipped).toEqual(['notes.txt'])
  })

  it('says so when the file is not a zip', async () => {
    await expect(filesFromZip(new File(['not a zip'], 'x.zip'))).rejects.toThrow(
      /could not be opened/
    )
  })

  const f = (path: string) => ({ path, file: new File(['x'], path.split('/').pop()!) })
  const four = [
    'Timesheets/t.pdf',
    'Payroll registers/r.pdf',
    'Pay stubs/s.pdf',
    'Bank statements/b.pdf',
  ]

  it('sorts a payroll zip by its folders, also when it was zipped one folder up', () => {
    const { files, problems } = sortPayrollZip(four.map(f), [])
    expect(problems).toEqual([])
    expect(files.map((x) => x.kind)).toEqual([
      'timesheet',
      'payroll-register',
      'paystub',
      'bank-statement',
    ])
    const nested = sortPayrollZip(
      four.map((p) => f(`payroll-2026-10/${p}`)),
      []
    )
    expect(nested.problems).toEqual([])
    expect(nested.files).toHaveLength(4)
  })

  it('names every problem with the layout at once', () => {
    const { problems } = sortPayrollZip(
      [f('Timesheets/t.pdf'), f('Stubs/s.pdf'), f('loose.pdf'), f('Pay stubs/a/deep.pdf')],
      ['Timesheets/notes.txt']
    )
    expect(problems).toEqual([
      'The zip has no "Payroll registers" folder, or it is empty.',
      'The zip has no "Bank & card statements" folder, or it is empty.',
      '"Stubs" is not one of the folders: use Timesheets, Payroll registers, Pay stubs, Bank & card statements, QuickBooks transactions, Program names, Account mapping and Receipts.',
      '2 files are not inside one of the folders (loose.pdf, Pay stubs/a/deep.pdf).',
      '1 file is not a PDF, PNG, JPG, XLSX, DOCX, CSV or ZIP (Timesheets/notes.txt).',
    ])
  })

  it('takes the files as exported: a CSV, a zip of pay stubs opened in its folder, and a program names file', async () => {
    const stubs = zipSync({
      'paystub-Morgan Lee.pdf': strToU8('%PDF-1.7'),
      'more/paystub-Priya Shah.pdf': strToU8('%PDF-1.7'),
    })
    const bytes = zipSync({
      'Timesheets/jobsReport (1).csv': strToU8('Employee,Hours'),
      'Payroll registers/Payments Report.pdf': strToU8('%PDF-1.7'),
      'Pay stubs/paystubs_run.zip': stubs,
      'Bank statements/September.pdf': strToU8('%PDF-1.7'),
      'Payroll details/Transaction List with Splits.xlsx': strToU8('PK'),
      'Program names/Program mapping.xlsx': strToU8('PK'),
    })
    const opened = await filesFromZip(new File([bytes], 'payroll.zip'))
    expect(opened.skipped).toEqual([])
    const { files, names, problems } = sortPayrollZip(opened.files, opened.skipped)
    expect(problems).toEqual([])
    expect(files.map((f) => [f.kind, f.file.name, f.file.type])).toEqual([
      ['timesheet', 'jobsReport (1).csv', 'text/csv'],
      ['payroll-register', 'Payments Report.pdf', 'application/pdf'],
      ['paystub', 'paystub-Morgan Lee.pdf', 'application/pdf'],
      ['paystub', 'more - paystub-Priya Shah.pdf', 'application/pdf'],
      ['bank-statement', 'September.pdf', 'application/pdf'],
      [
        'payroll-details',
        'Transaction List with Splits.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
    ])
    expect(names.map((n) => n.name)).toEqual(['Program mapping.xlsx'])
  })

  it('needs no pay stubs (a month of staff pay only), and says where a CSV may go', () => {
    const { problems } = sortPayrollZip(
      [
        f('Timesheets/t.csv'),
        f('Payroll registers/r.pdf'),
        f('Bank statements/b.pdf'),
        f('Bank statements/b.csv'),
      ],
      []
    )
    expect(problems).toEqual([
      '1 file is in a folder that does not take its type: a CSV goes in Timesheets, Payroll registers, QuickBooks transactions, Program names or Account mapping, Program names takes CSV or XLSX, Account mapping takes CSV or XLSX, Receipts takes PDF, PNG or JPG (Bank statements/b.csv).',
    ])
  })

  it('reads a zip of the payroll zip as the payroll zip', async () => {
    const inner = zipSync({
      'Timesheets/t.pdf': strToU8('%PDF-1.7'),
      'Payroll registers/r.pdf': strToU8('%PDF-1.7'),
      'Bank statements/b.pdf': strToU8('%PDF-1.7'),
    })
    const opened = await filesFromZip(
      new File([zipSync({ 'October payroll.zip': inner })], 'x.zip')
    )
    expect(sortPayrollZip(opened.files, opened.skipped).problems).toEqual([])
  })
})
