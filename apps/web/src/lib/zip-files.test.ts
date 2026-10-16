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

  it('sorts a payroll zip by its four folders, also when it was zipped one folder up', () => {
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
      'The zip has no "Pay stubs" folder, or it is empty.',
      'The zip has no "Bank statements" folder, or it is empty.',
      '"Stubs" is not one of the folders: use Timesheets, Payroll registers, Pay stubs and Bank statements.',
      '2 files are not inside one of the four folders (loose.pdf, Pay stubs/a/deep.pdf).',
      '1 file is not a PDF, PNG, JPG, XLSX or DOCX (Timesheets/notes.txt).',
    ])
  })
})
