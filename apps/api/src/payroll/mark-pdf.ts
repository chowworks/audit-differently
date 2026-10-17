import { PDFArray, PDFDict, PDFDocument, PDFName, rgb } from 'pdf-lib'
import type { StatementMark } from '@ad/types'

/** What marking did: the copy's bytes, and the marks that could not be drawn on it. */
export interface MarkedPdf {
  bytes: Uint8Array
  /** Marks left off the copy: all of them when the statement is encrypted or damaged (then `bytes` is the original). */
  notDrawn: StatementMark[]
}

/** The notes a copy for one item keeps: links and form fields, which point at no one. */
const KEPT = new Set(['/Link', '/Widget'])

/**
 * Removes every note the file already carries over its pages but links and form fields: highlights, boxes, circles,
 * ink, stamps, sticky notes and the rest (a bank's statement often comes marked up, perhaps around another person's
 * line), so the only marks on a copy are the item's own. Marks printed into the page itself cannot be told from the
 * page and stay.
 */
function stripPointers(pdf: PDFDocument) {
  for (const page of pdf.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'))
    if (!(annots instanceof PDFArray)) continue
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i)
      const kind = a instanceof PDFDict ? a.get(PDFName.of('Subtype'))?.toString() : undefined
      if (!kind || !KEPT.has(kind)) annots.remove(i)
    }
  }
}

/**
 * A copy of the statement with each marked line highlighted (a semi-transparent yellow box with an outline), for the
 * audit package. The stored original is never changed: this works on the bytes given and returns new ones. An
 * encrypted statement (an owner password is common on bank statements) cannot be redrawn usefully, since its pages
 * stay encrypted, and a damaged one cannot be opened: both come back as given, with every mark in `notDrawn`. A mark
 * on a page the statement does not have is in `notDrawn` too. Never throws for a bad file.
 */
export async function markPdf(
  bytes: Uint8Array,
  marks: StatementMark[],
  options: { strip?: boolean } = {}
): Promise<MarkedPdf> {
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  } catch {
    return { bytes, notDrawn: marks }
  }
  if (pdf.isEncrypted) return { bytes, notDrawn: marks }
  if (options.strip) stripPointers(pdf)
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

/**
 * One item's own copy of a payroll proof: the file's own highlight notes removed and only this item's marks drawn, so
 * the copy stands on its own for the auditor (owner's decision, 2026-10-16). The stored original is never changed.
 */
export const itemCopy = (bytes: Uint8Array, marks: StatementMark[]) =>
  markPdf(bytes, marks, { strip: true })
