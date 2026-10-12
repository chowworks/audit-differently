/** @type {import('tailwindcss').Config} */
// Colours are CSS variables (src/index.css) so a palette can be swapped without touching components.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: 'var(--ink)',
        navy: 'var(--navy)',
        soft: 'var(--muted)',
        line: 'var(--line)',
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        alt: 'var(--surface-alt)',
        tint: 'var(--tint)',
        accent: 'var(--accent)',
        brand: 'var(--brand)',
        'brand-text': 'var(--brand-text)',
        ok: 'var(--ok)',
        'ok-tint': 'var(--ok-tint)',
        warn: 'var(--warn)',
        'warn-tint': 'var(--warn-tint)',
        danger: 'var(--danger)',
        'danger-tint': 'var(--danger-tint)',
      },
      fontFamily: {
        sans: ['Manrope', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card: 'var(--radius)',
      },
    },
  },
  plugins: [],
}
