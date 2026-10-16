import { PDFDocument, rgb } from 'pdf-lib'
import type { StatementMark } from '@ad/types'

/** What marking did: the copy's bytes, and the marks that could not be drawn on it. */
export interface MarkedPdf {
  bytes: Uint8Array
  /** Marks left off the copy: all of them when the statement is encrypted or damaged (then `bytes` is the original). */
  notDrawn: StatementMark[]
}

/**
 * A copy of the statement with each marked line highlighted (a semi-transparent yellow box with an outline), for the
 * audit package. The stored original is never changed: this works on the bytes given and returns new ones. An
 * encrypted statement (an owner password is common on bank statements) cannot be redrawn usefully, since its pages
 * stay encrypted, and a damaged one cannot be opened: both come back as given, with every mark in `notDrawn`. A mark
 * on a page the statement does not have is in `notDrawn` too. Never throws for a bad file.
 */
export async function markPdf(bytes: Uint8Array, marks: StatementMark[]): Promise<MarkedPdf> {
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  } catch {
    return { bytes, notDrawn: marks }
  }
  if (pdf.isEncrypted) return { bytes, notDrawn: marks }
  const pages = pdf.getPages()
  const notDrawn: StatementMark[] = []
  for (const m of marks) {
    const page = pages[m.page - 1]
    if (!page) {
      notDrawn.push(m)
      continue
    }
    page.drawRectangle({
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height,
      color: rgb(1, 0.84, 0),
      opacity: 0.35,
      borderColor: rgb(0.85, 0.55, 0),
      borderWidth: 1,
      borderOpacity: 0.9,
    })
  }
  try {
    return { bytes: await pdf.save(), notDrawn }
  } catch {
    return { bytes, notDrawn: marks }
  }
}

/** Said where marks could not be drawn, followed by `markPlace` of each. */
export const NOT_DRAWN = 'The marked lines could not be drawn on this copy (encrypted or damaged):'

/** Where a mark sits, so a reader can find the line by hand: "page 2, at 48, 677". */
export const markPlace = (m: StatementMark) =>
  `page ${m.page}, at ${Math.round(m.x)}, ${Math.round(m.y)}`
