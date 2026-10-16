/** A one-page PDF of plain lines, for fictional seed documents. No library: the file is written by hand. */
export function simplePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const ops = ['BT', '/F1 18 Tf', '72 720 Td', `(${esc(lines[0] ?? '')}) Tj`, '/F1 12 Tf']
  for (const line of lines.slice(1)) ops.push('0 -22 Td', `(${esc(line)}) Tj`)
  ops.push('ET')
  const content = ops.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/**
 * A row of a laid-out page: a line of text, words that follow one another on one line (each its own text run, so an
 * exact-word highlight lands on it), or table cells at fixed x positions (`at`, in points from the left edge).
 */
export type PdfRow = string | string[] | { at: number[]; cells: string[] } | null

/**
 * A one-page PDF drawn with pdf-lib, for the fictional payroll proof of the demo: a title, then each row 15 points
 * below the last (`null` is a blank row). Every cell is its own text run, as a payroll or bank export writes them, so
 * the reader (`src/payroll/statement-lines.ts`) finds each value with its own box and the highlights the matcher
 * cuts from those boxes sit on the words. Ends with the fictional-data footer.
 */
export async function layoutPdf(title: string, rows: PdfRow[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.setCreator('Audit Differently demo seed')
  pdf.setCreationDate(new Date('2026-10-01T00:00:00Z'))
  pdf.setModificationDate(new Date('2026-10-01T00:00:00Z'))
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])
  const size = 10
  page.drawText(title, { x: 48, y: 745, size: 16, font })
  let y = 722
  for (const row of rows) {
    if (typeof row === 'string') page.drawText(row, { x: 48, y, size, font })
    else if (Array.isArray(row)) {
      let x = 48
      for (const cell of row) {
        page.drawText(cell, { x, y, size, font })
        // A gap wider than pdf.js joins (0.6 of the font size), so each cell stays its own text run when read.
        x += font.widthOfTextAtSize(cell, size) + size * 0.7
      }
    } else if (row)
      row.cells.forEach((cell, i) => {
        if (cell) page.drawText(cell, { x: row.at[i] ?? 48, y, size, font })
      })
    y -= 15
  }
  page.drawText('Fictional document generated for the Audit Differently demo.', {
    x: 48,
    y: 30,
    size: 8,
    font,
  })
  return Buffer.from(await pdf.save({ useObjectStreams: false }))
}
