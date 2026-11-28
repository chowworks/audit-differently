import { describe, expect, it } from 'vitest'
import type { BudgetFileDto } from '@ad/types'
import { ApiError } from '@/services/api'
import { refusedCheck } from './budget-refusal'

const check: BudgetFileDto = {
  rows: [],
  removed: [],
  problems: [{ row: null, reason: 'Rent has spending, so it must stay in the file' }],
}

describe('a refused budget upload', () => {
  it('gives the check it carries, so the screen shows every problem in place of the older check', () => {
    const e = new ApiError(400, 'The file has 1 problem: correct the file and upload it again', {
      message: 'The file has 1 problem: correct the file and upload it again',
      problems: check.problems,
      check,
    })
    expect(refusedCheck(e)).toEqual(check)
  })

  it('gives nothing for another error', () => {
    expect(refusedCheck(new ApiError(500, 'failed', null))).toBeNull()
    expect(
      refusedCheck(new ApiError(400, 'Choose a budget file to upload', { message: 'x' }))
    ).toBeNull()
    expect(refusedCheck(new Error('network'))).toBeNull()
  })
})
