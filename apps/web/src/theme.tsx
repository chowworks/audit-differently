import { createContext, useContext, useEffect, useMemo, useState } from 'react'

/**
 * The colour theme, chosen from the account menu and kept in this browser. The CSS for each key is in
 * themes.css; the default ("navy-band") is the :root block in index.css.
 */
export type ThemeKey = 'navy-green' | 'navy-band' | 'evergreen' | 'mint'

export const THEMES: { key: ThemeKey; label: string }[] = [
  { key: 'navy-band', label: 'Navy band' },
  { key: 'navy-green', label: 'Navy green' },
  { key: 'evergreen', label: 'Evergreen' },
  { key: 'mint', label: 'Mint' },
]
export const DEFAULT_THEME: ThemeKey = 'navy-band'
const STORAGE_KEY = 'ad-theme'

const isKey = (v: string | null): v is ThemeKey => THEMES.some((t) => t.key === v)

const ThemeContext = createContext<{ theme: ThemeKey; setTheme: (t: ThemeKey) => void }>({
  theme: DEFAULT_THEME,
  setTheme: () => undefined,
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeKey>(() => {
    try {
      const kept = localStorage.getItem(STORAGE_KEY)
      return isKey(kept) ? kept : DEFAULT_THEME
    } catch {
      return DEFAULT_THEME
    }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* private window: the choice lasts for the page */
    }
  }, [theme])
  const value = useMemo(() => ({ theme, setTheme }), [theme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
