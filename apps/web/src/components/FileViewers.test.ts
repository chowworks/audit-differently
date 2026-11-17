import { describe, expect, it } from 'vitest'
import { cssPixels } from './FileViewers'

describe('cssPixels', () => {
  it("reads a Word page's width in CSS pixels", () => {
    expect(cssPixels('8.5in')).toBe(816)
    expect(cssPixels('612pt')).toBe(816)
    expect(cssPixels('210mm')).toBeCloseTo(793.7, 1)
    expect(cssPixels('auto')).toBe(0)
  })
})
