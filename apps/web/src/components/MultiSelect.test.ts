import { describe, expect, it } from 'vitest'
import { matching, moved, toggled } from './MultiSelect'

const options = [
  { value: 'funding-source:youth', label: 'Youth Workforce Fund' },
  { value: 'funding-source:adult', label: 'Adult Training Fund' },
  { value: 'funding-source:state', label: 'State General Fund' },
]

describe('the multi-select', () => {
  it('finds the options holding every word typed, in any case', () => {
    expect(matching(options, '').map((o) => o.label)).toHaveLength(3)
    expect(matching(options, 'fund TRAIN').map((o) => o.label)).toEqual(['Adult Training Fund'])
    expect(matching(options, 'nothing')).toEqual([])
  })

  it("ticks and unticks a value, keeping the list's order and anything else chosen", () => {
    expect(toggled(options, [], 'funding-source:state')).toEqual(['funding-source:state'])
    expect(toggled(options, ['funding-source:state'], 'funding-source:youth')).toEqual([
      'funding-source:youth',
      'funding-source:state',
    ])
    expect(toggled(options, ['old:gone', 'funding-source:youth'], 'funding-source:youth')).toEqual([
      'old:gone',
    ])
  })

  it('moves the highlight with the arrow keys, wrapping at both ends', () => {
    expect(moved(-1, 1, 3)).toBe(0)
    expect(moved(-1, -1, 3)).toBe(2)
    expect(moved(2, 1, 3)).toBe(0)
    expect(moved(0, -1, 3)).toBe(2)
    expect(moved(0, 1, 0)).toBe(-1)
  })
})
