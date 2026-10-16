import { describe, expect, it } from 'vitest'
import { notSearchedNote } from './PayrollProof'

describe('"Find the line" on a month with many statements', () => {
  it('says how many older statements were left out', () => {
    expect(notSearchedNote(1)).toBe('1 older statement of this month was not searched.')
    expect(notSearchedNote(3)).toBe('3 older statements of this month were not searched.')
  })
})
