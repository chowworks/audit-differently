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

/** A payroll CSV (timesheet, register, payroll details): shown as a table in the app. */
export const isCsv = (f: { contentType?: string; fileName: string }) =>
  /csv/i.test(f.contentType ?? '') || /\.csv$/i.test(f.fileName)
/** A PDF, a Word file or a picture, by its type or name. */
export const isPdf = (f: { contentType?: string; fileName: string }) =>
  /pdf/i.test(f.contentType ?? '') || /\.pdf$/i.test(f.fileName)
export const isDocx = (f: { contentType?: string; fileName: string }) =>
  /wordprocessingml\.document/i.test(f.contentType ?? '') || /\.docx$/i.test(f.fileName)
export const isImage = (f: { contentType?: string; fileName: string }) =>
  /^image\//i.test(f.contentType ?? '') || /\.(png|jpe?g)$/i.test(f.fileName)
/** An xlsx file, by its type or name. */
export const isXlsx = (f: { contentType?: string; fileName: string }) =>
  /spreadsheetml\.sheet/i.test(f.contentType ?? '') || /\.xlsx$/i.test(f.fileName)
