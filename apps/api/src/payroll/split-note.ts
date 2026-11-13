import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { PayrollSplitDto } from '@ad/types'

/**
 * The note a split staff line's pay stub opens with (owner's decision, 2026-11-03): the stub shows the person's whole pay,
 * the line one program's share, so the copy first says why, with the split by program and the line's own row marked.
 * Drawn as a page of its own before the stub's, so nothing on the stub is covered.
 */

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const hoursWords = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const cents = (n: number) => Math.round(n * 100) / 100

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return { y: y!, words: `${MONTHS[m! - 1]} ${d}` }
}
/** "Sep 16 – Sep 30, 2026", or "ending Sep 30, 2026". */
export const periodWords = (start: string | null, end: string) => {
  const e = day(end)
  if (!start) return `the period ending ${e.words}, ${e.y}`
  const s = day(start)
  return s.y === e.y ? `${s.words} – ${e.words}, ${e.y}` : `${s.words}, ${s.y} – ${e.words}, ${e.y}`
}

/** The note's words: its title, what it says, and the table's rows (each program, then the total). */
export function splitNoteText(split: PayrollSplitDto) {
  const total = cents(split.rows.reduce((t, r) => t + r.amount, 0))
  const mine = split.rows.filter((r) => r.mine)
  const line = cents(mine.reduce((t, r) => t + r.amount, 0))
  const program = mine.map((r) => r.program).join(' and ')
  const hours = split.rows.every((r) => r.hours !== null)
  const allHours = cents(split.rows.reduce((t, r) => t + (r.hours ?? 0), 0))
  const myHours = cents(mine.reduce((t, r) => t + (r.hours ?? 0), 0))
  const period = periodWords(split.start, split.end)
  const how = hours
    ? 'Payroll charges it to each program by the hours worked on it.'
    : 'Payroll charges it to each program as the table shows.'
  const share = hours
    ? `This line is the share of ${program}: ${hoursWords(myHours)} of ${hoursWords(allHours)} hours, ${money(line)}.`
    : `This line is the share of ${program}: ${money(line)}.`
  const title =
    split.kind === 'pay'
      ? `Why this line is ${money(line)} of ${split.who}'s ${money(total)} pay`
      : `Why this line is ${money(line)}`
  const body =
    split.kind === 'pay'
      ? `This pay stub shows ${split.who}'s whole pay for ${period}: ${money(total)}. ${how} ${share}`
      : `This pay stub shows ${split.who}'s pay for ${period}. This line is the employer's taxes and benefits on that pay, ${money(total)} in all, which a pay stub does not show in full. ${how} ${share}`
  const rows = split.rows.map((r) => ({
    program: r.program,
    hours: r.hours === null ? null : hoursWords(r.hours),
    share: total
      ? `${((hours ? (r.hours ?? 0) / allHours : r.amount / total) * 100).toFixed(2)}%`
      : '',
    amount: money(r.amount),
    mine: r.mine,
  }))
  return {
    title,
    body,
    hours,
    rows,
    total: {
      hours: hours ? hoursWords(allHours) : null,
      amount: money(total),
    },
    footer: 'Added by Audit Differently to this copy of the pay stub. The pay stub follows.',
  }
}

/** Text a standard font can draw: a character it has no glyph for becomes "?", never a failed copy. */
function drawable(font: PDFFont, text: string) {
  let out = ''
  for (const ch of text) {
    try {
      font.encodeText(ch)
      out += ch
    } catch {
      out += '?'
    }
  }
  return out
}

/** The words in lines no wider than `width`. */
function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  const lines: string[] = []
  let now = ''
  for (const word of text.split(/\s+/)) {
    const next = now ? `${now} ${word}` : word
    if (now && font.widthOfTextAtSize(next, size) > width) {
      lines.push(now)
      now = word
    } else now = next
  }
  if (now) lines.push(now)
  return lines
}

/** Puts the note before the stub's first page: the same size as it, else US Letter. */
export async function addSplitNote(pdf: PDFDocument, split: PayrollSplitDto): Promise<void> {
  const note = splitNoteText(split)
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const first = pdf.getPages()[0]
  const size = first ? first.getSize() : { width: 612, height: 792 }
  const page: PDFPage = pdf.insertPage(0, [size.width, size.height])
  const margin = 48
  const width = size.width - margin * 2
  let y = size.height - margin
  const ink = rgb(0.1, 0.12, 0.16)
  const soft = rgb(0.38, 0.42, 0.48)
  const text = (t: string, x: number, at: number, font: PDFFont, s: number, color = ink) =>
    page.drawText(drawable(font, t), { x, y: at, size: s, font, color })
  const para = (t: string, font: PDFFont, s: number, gap: number, color = ink) => {
    for (const l of wrap(font, s, drawable(font, t), width)) {
      y -= s + gap
      text(l, margin, y, font, s, color)
    }
  }

  para(note.title, bold, 15, 4)
  y -= 6
  para(note.body, regular, 10.5, 4.5)
  y -= 18

  // The table: program (wrapped), then hours, share and amount right-aligned.
  const cols = note.hours
    ? { hours: margin + width * 0.62, share: margin + width * 0.8, amount: margin + width }
    : { hours: 0, share: margin + width * 0.8, amount: margin + width }
  const programWidth = (note.hours ? width * 0.5 : width * 0.66) - 8
  const right = (t: string, x: number, at: number, font: PDFFont, s: number, color = ink) =>
    text(t, x - font.widthOfTextAtSize(drawable(font, t), s), at, font, s, color)
  const s = 10
  const row = (
    cells: { program: string; hours: string | null; share: string; amount: string },
    font: PDFFont,
    mark: boolean
  ) => {
    const lines = wrap(font, s, drawable(font, cells.program), programWidth)
    const h = lines.length * (s + 3) + 8
    if (mark)
      page.drawRectangle({
        x: margin - 4,
        y: y - h + 2,
        width: width + 8,
        height: h,
        color: rgb(1, 0.84, 0),
        opacity: 0.35,
        borderColor: rgb(0.85, 0.55, 0),
        borderWidth: 1,
        borderOpacity: 0.9,
      })
    let at = y - s - 2
    for (const l of lines) {
      text(l, margin, at, font, s)
      at -= s + 3
    }
    const top = y - s - 2
    if (note.hours && cells.hours !== null) right(cells.hours, cols.hours, top, font, s)
    right(cells.share, cols.share, top, font, s)
    right(cells.amount, cols.amount, top, font, s)
    y -= h
  }
  const head = (t: string, x: number, alignRight = true) =>
    alignRight ? right(t, x, y - s, bold, 9, soft) : text(t, x, y - s, bold, 9, soft)
  head('Program', margin, false)
  if (note.hours) head('Hours', cols.hours)
  head('Share', cols.share)
  head(split.kind === 'pay' ? 'Pay' : 'Taxes & benefits', cols.amount)
  y -= s + 6
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + width, y },
    thickness: 0.8,
    color: soft,
  })
  for (const r of note.rows)
    row(
      { ...r, program: r.mine ? `${r.program}  (this line)` : r.program },
      r.mine ? bold : regular,
      r.mine
    )
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + width, y },
    thickness: 0.8,
    color: soft,
  })
  row(
    {
      program: split.kind === 'pay' ? 'Total pay' : 'Total',
      hours: note.total.hours,
      share: '100.00%',
      amount: note.total.amount,
    },
    bold,
    false
  )
  y -= 18
  para(note.footer, regular, 8.5, 3, soft)
}
