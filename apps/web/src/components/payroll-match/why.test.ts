import { describe, expect, it } from 'vitest'
import type { PayrollSlotMatch } from '@ad/types'
import { provedWords, slotWhy } from './why'

const match = (pick: string | null, sure: boolean): PayrollSlotMatch => ({
  target: 'expense',
  id: 'e1',
  slot: 'register',
  pick,
  why: 'No file shows this item. Choose one by hand.',
  candidates: [
    {
      fileId: 'f1',
      mark: null,
      marks: [],
      sure,
      score: 4,
      why: '$2,400.00 on page 1, in a file for a date near 09/25/2026.',
    },
  ],
})
const base = {
  attached: null,
  chosen: undefined,
  fileName: (id: string) => `${id}.pdf`,
  noLine: () => false,
  noLineText: 'Find it under Unmatched payments.',
}

describe('"How Auto-Match decided", on both payroll match screens', () => {
  it("says how each proof came out, in Auto-Match's own words", () => {
    expect(slotWhy({ ...base, attached: { file: 'a.pdf' }, match: match('f1', true) })).toEqual({
      tone: 'ok',
      file: 'a.pdf',
      text: 'Already attached.',
    })
    expect(slotWhy({ ...base, match: match('f1', true) })).toEqual({
      tone: 'ok',
      file: 'f1.pdf',
      text: '$2,400.00 on page 1, in a file for a date near 09/25/2026.',
    })
    expect(slotWhy({ ...base, match: match('f1', false) }).tone).toBe('guess')
    expect(slotWhy({ ...base, match: match(null, false) })).toEqual({
      tone: 'missing',
      file: undefined,
      text: 'No file shows this item. Choose one by hand.',
    })
    expect(slotWhy({ ...base, chosen: '', match: match('f1', true) }).text).toBe('Cleared by you.')
    expect(slotWhy({ ...base, chosen: 'f1', match: match(null, false) }).text).toBe(
      'Chosen by you. $2,400.00 on page 1, in a file for a date near 09/25/2026.'
    )
    expect(slotWhy({ ...base, noLine: () => true, match: match('f1', true) })).toEqual({
      tone: 'next',
      file: 'f1.pdf',
      text: 'Find it under Unmatched payments.',
    })
    expect(slotWhy({ ...base, match: undefined }).text).toBe('Nothing read yet.')
  })

  it('counts the items fully proved', () => {
    expect(provedWords(1, 1)).toBe('1 of 1 payroll item fully proved')
    expect(provedWords(5, 7)).toBe('5 of 7 payroll items fully proved')
  })
})
