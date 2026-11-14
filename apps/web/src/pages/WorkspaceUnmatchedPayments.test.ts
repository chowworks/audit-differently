import { describe, expect, it } from 'vitest'
import type { PayrollReconciliationDto } from '@ad/types'
import { unmatchedPayments } from './WorkspaceUnmatchedPayments'

const item = (id: string, kind: 'staff' | 'participant', proved: string[]) => ({
  item: { target: kind === 'staff' ? 'expense' : 'wex', id, kind, title: id, proved },
  needed: kind === 'staff' ? ['timesheet', 'register', 'bank'] : ['timesheet', 'register', 'stub'],
})

describe('unmatchedPayments', () => {
  it('lists the staff lines Save left with no bank line, nothing else', () => {
    const recon = {
      items: [
        item('x-1', 'staff', ['timesheet', 'register']),
        item('x-2', 'staff', ['timesheet', 'register', 'bank']),
        item('w-1', 'participant', ['timesheet']),
      ],
    } as unknown as PayrollReconciliationDto
    expect(unmatchedPayments(recon).map((i) => i.id)).toEqual(['x-1'])
    expect(unmatchedPayments(null)).toEqual([])
  })
})
