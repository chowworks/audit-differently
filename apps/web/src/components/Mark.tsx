/** The mark beside the wordmark: a receipt with a sealed tick, spending and its proof. Colours follow the theme. */
export function Mark({ size = 34 }: { size?: number }) {
  const ink = 'var(--mark-ink)'
  const fill = 'var(--mark-fill)'
  const seal = 'var(--brand)'
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <path
        d="M10 4h20v30l-3.3-2.6-3.4 2.6-3.3-2.6-3.3 2.6-3.4-2.6L10 34z"
        fill={fill}
        stroke={ink}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <line x1="15" y1="12" x2="25" y2="12" stroke={ink} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="15" y1="18" x2="25" y2="18" stroke={ink} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="15" y1="24" x2="20" y2="24" stroke={ink} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="29" cy="29" r="8" fill={seal} stroke={ink} strokeWidth="2.5" />
      <path
        d="M25 29l3 3 5-6"
        fill="none"
        stroke={ink}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
