export const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })

export const periodLabel = (period: string) => {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export const shortDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : ''

export const nextPeriod = (period: string) => {
  const [y, m] = period.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

export const titleCase = (s: string) => s.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/**
 * A work-experience payment's pay period, short, as the payroll grids' "Date" column shows it:
 * "Sep 7–20, 2026", or "Sep 27 – Oct 10, 2026" across months.
 */
export const payPeriodWords = (start: string, end: string) => {
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`)
  const mon = (iso: string) =>
    d(iso).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
  const day = (iso: string) => d(iso).getUTCDate()
  const year = end.slice(0, 4)
  return start.slice(0, 7) === end.slice(0, 7)
    ? `${mon(start)} ${day(start)}–${day(end)}, ${year}`
    : `${mon(start)} ${day(start)} – ${mon(end)} ${day(end)}, ${year}`
}
