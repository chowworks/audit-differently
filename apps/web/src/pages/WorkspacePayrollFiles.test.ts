import { describe, expect, it } from 'vitest'
import type { WorkspacePayrollFileDto } from '@ad/types'
import { payrollFolders } from './WorkspacePayrollFiles'

const file = (fileName: string, kind: string): WorkspacePayrollFileDto =>
  ({
    id: fileName,
    kind,
    fileName,
    size: 1,
    sha256: fileName,
    uploadedAt: '2026-09-02T00:00:00Z',
    personal: false,
  }) as WorkspacePayrollFileDto

describe('payrollFolders', () => {
  it("lays the month's files out as the zip does: a folder per kind, in its order, files by name", () => {
    const got = payrollFolders([
      file('stub-10.pdf', 'paystub'),
      file('Jordan Sample.pdf', 'paystub'),
      file('stub-9.pdf', 'paystub'),
      file('hours.csv', 'timesheet'),
    ])
    expect(got.map((g) => [g.name, g.files.map((f) => f.fileName)])).toEqual([
      ['Timesheets', ['hours.csv']],
      ['Payroll registers', []],
      ['Pay stubs', ['Jordan Sample.pdf', 'stub-9.pdf', 'stub-10.pdf']],
      ['Bank statements', []],
      ['Payroll details', []],
    ])
  })
})
