import { describe, expect, it } from 'vitest'
import { ENGAGEMENT_COLORS } from '@/lib/engagement-colors'
import { shapeOf } from './EngagementMark'

describe('shapeOf', () => {
  it('gives each of the ten engagements its own colour and shape pair, and neighbours different shapes', () => {
    const pairs = ENGAGEMENT_COLORS.map((c) => `${c}|${shapeOf(c)}`)
    expect(new Set(pairs).size).toBe(ENGAGEMENT_COLORS.length)
    for (let i = 1; i < ENGAGEMENT_COLORS.length; i++)
      expect(shapeOf(ENGAGEMENT_COLORS[i]!)).not.toBe(shapeOf(ENGAGEMENT_COLORS[i - 1]!))
  })

  it('draws a colour it does not know as a circle', () => {
    expect(shapeOf('var(--navy)')).toBe('circle')
  })
})
