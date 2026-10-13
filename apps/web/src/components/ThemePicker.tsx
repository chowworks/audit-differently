import { THEMES, type ThemeKey, useTheme } from '@/theme'

/**
 * The colour theme selector, in the app's account menu. The choice is kept in this browser (theme.tsx), so the
 * public homepage shows it too, though it has no selector of its own.
 */
export function ThemeOptions() {
  const { theme, setTheme } = useTheme()
  return (
    <fieldset className="ad-account-group">
      <legend className="ad-account-heading">Theme selector</legend>
      <ul>
        {THEMES.map((t) => (
          <li key={t.key}>
            <label className="ad-account-option">
              <input
                type="radio"
                name="theme"
                value={t.key}
                checked={theme === t.key}
                onChange={() => setTheme(t.key)}
              />
              <ThemeIcon theme={t.key} />
              {t.label}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  )
}

/** One small picture per theme, drawn in that theme's own colours so the list reads at a glance. */
function ThemeIcon({ theme }: { theme: ThemeKey }) {
  const common = { width: 24, height: 24, viewBox: '0 0 24 24', 'aria-hidden': true } as const
  switch (theme) {
    case 'navy-band':
      // Paper page with the navy header band and its green seal.
      return (
        <svg {...common}>
          <rect
            x="1.5"
            y="1.5"
            width="21"
            height="21"
            rx="5"
            fill="#f6f7f4"
            stroke="#0b1f2e"
            strokeWidth="1.5"
          />
          <path d="M1.5 6.5a5 5 0 0 1 5-5h11a5 5 0 0 1 5 5V10h-21z" fill="#0b1f2e" />
          <circle cx="7" cy="6" r="2" fill="#27b35e" />
        </svg>
      )
    case 'navy-green':
      // Paper page, navy edge, the green slash.
      return (
        <svg {...common}>
          <rect
            x="1.5"
            y="1.5"
            width="21"
            height="21"
            rx="5"
            fill="#f6f7f4"
            stroke="#0b1f2e"
            strokeWidth="1.5"
          />
          <line
            x1="15"
            y1="5"
            x2="9"
            y2="19"
            stroke="#27b35e"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'evergreen':
      // A pine on deep green.
      return (
        <svg {...common}>
          <rect
            x="1.5"
            y="1.5"
            width="21"
            height="21"
            rx="5"
            fill="#0f5132"
            stroke="#0a2e1f"
            strokeWidth="1.5"
          />
          <path d="M12 4l4.5 6h-2.5l3.5 5h-3l3 4.5H6.5l3-4.5h-3L10 10H7.5z" fill="#2ecc71" />
        </svg>
      )
    case 'mint':
    default:
      // A mint leaf on mint paper.
      return (
        <svg {...common}>
          <rect
            x="1.5"
            y="1.5"
            width="21"
            height="21"
            rx="5"
            fill="#e9f5ee"
            stroke="#0b1f2e"
            strokeWidth="1.5"
          />
          <path d="M6 18c0-7 5-11 12-12-0.5 7-4.5 12-12 12z" fill="#19c37d" />
          <path
            d="M7 17c2.5-4 5-7 9-9"
            fill="none"
            stroke="#0b1f2e"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )
  }
}
