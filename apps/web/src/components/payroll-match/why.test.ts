import { describe, expect, it } from 'vitest'
import { provedWords } from './why'

describe('the words both payroll match screens share', () => {
  it('counts the items fully proved', () => {
    expect(provedWords(1, 1)).toBe('1 of 1 payroll item complete')
    expect(provedWords(5, 7)).toBe('5 of 7 payroll items complete')
  })
})
