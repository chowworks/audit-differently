import { ENGAGEMENT_COLORS } from '@/lib/engagement-colors'

/** The shapes, in turn with the colours: no two of the ten engagements share both, and neither is told by colour alone. */
const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'hexagon'] as const
export type EngagementShape = (typeof SHAPES)[number]

/** An engagement's shape, from its colour's place in the list (the shape follows wherever the colour goes). */
export function shapeOf(color: string): EngagementShape {
  const at = (ENGAGEMENT_COLORS as readonly string[]).indexOf(color)
  return SHAPES[(at >= 0 ? at : 0) % SHAPES.length]!
}

const PATHS: Record<EngagementShape, string> = {
  circle: 'M6 1a5 5 0 1 1 0 10A5 5 0 0 1 6 1z',
  square: 'M1.5 1.5h9v9h-9z',
  triangle: 'M6 0.8l5.4 9.7H0.6z',
  diamond: 'M6 0.5l5.5 5.5L6 11.5 0.5 6z',
  hexagon: 'M3.2 1h5.6L11.6 6 8.8 11H3.2L0.4 6z',
}

/** An engagement's mark: its colour in its shape, which never shrinks when the name beside it wraps. */
export function EngagementMark({ color }: { color: string }) {
  return (
    <svg
      className="ad-eng-mark"
      viewBox="0 0 12 12"
      width="11"
      height="11"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[shapeOf(color)]} fill={color} />
    </svg>
  )
}
