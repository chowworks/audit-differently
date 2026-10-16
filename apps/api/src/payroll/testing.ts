import { PDFDocument, PDFName } from 'pdf-lib'

/** For tests: a PDF whose trailer names an /Encrypt dictionary, the way an owner-password bank statement does. */
export async function encryptedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.addPage([612, 792])
  pdf.context.trailerInfo.Encrypt = pdf.context.obj({
    Filter: PDFName.of('Standard'),
    V: 2,
    R: 3,
    Length: 128,
    P: -3904,
  })
  return pdf.save({ useObjectStreams: false })
}
