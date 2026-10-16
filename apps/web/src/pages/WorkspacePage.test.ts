import { describe, expect, it } from 'vitest'
import type { TagType } from '@ad/types'
import { tagRemovals, usesWords } from './WorkspacePage'

const funding: TagType = {
  key: 'funding-source',
  label: 'Funding source',
  appliesTo: ['engagement', 'expense', 'payroll', 'participant'],
  values: [
    { key: 'youth', label: 'Youth Workforce Fund' },
    { key: 'old', label: 'Old Fund' },
  ],
}

describe('the warning before a tag is removed', () => {
  it('says how many records each removed value comes off', () => {
    const after = [{ ...funding, values: [{ key: 'youth', label: 'Youth Futures Fund' }] }]
    const uses = { 'funding-source:old': { expense: 3, participant: 1, engagement: 2 } }
    expect(tagRemovals([funding], after, uses)).toEqual([
      'Old Fund (Funding source) comes off 3 expenses, 1 participant and 2 engagements',
    ])
  })

  it('counts a renamed value as kept, and a removed type as each of its values', () => {
    expect(tagRemovals([funding], [{ ...funding, label: 'Fund' }], {})).toEqual([])
    expect(tagRemovals([funding], [], {})).toEqual([
      'Youth Workforce Fund (Funding source) comes off no record',
      'Old Fund (Funding source) comes off no record',
    ])
    expect(tagRemovals([funding], [])[0]).toMatch(/comes off every record that has it$/)
  })

  it('words the counts', () => {
    expect(usesWords({ payroll: 1 })).toBe('1 payroll item')
    expect(usesWords({ expense: 2, engagement: 1 })).toBe('2 expenses and 1 engagement')
  })
})
