import { Suspense, lazy } from 'react'
import type { DocumentDto, StatementMark } from '@ad/types'
import { isCsv, isDocx, isImage, isPdf, isXlsx } from '@/lib/format'

/** Each viewer loads when a file of its kind is first shown (pdf.js and the Word reader are large). */
const StatementViewer = lazy(() =>
  import('@/components/StatementViewer').then((m) => ({ default: m.StatementViewer }))
)
const CsvViewer = lazy(() =>
  import('@/components/CsvViewer').then((m) => ({ default: m.CsvViewer }))
)
const SheetViewer = lazy(() =>
  import('@/components/SheetViewer').then((m) => ({ default: m.SheetViewer }))
)
const ImageViewer = lazy(() =>
  import('@/components/FileViewers').then((m) => ({ default: m.ImageViewer }))
)
const DocxViewer = lazy(() =>
  import('@/components/FileViewers').then((m) => ({ default: m.DocxViewer }))
)

type Viewable = { fileName: string; contentType?: string }

/** Whether the app shows this file itself: every type an upload takes. */
export const canView = (f: Viewable) => isPdf(f) || isCsv(f) || isXlsx(f) || isDocx(f) || isImage(f)

/**
 * A file shown in the app, by its type: a PDF in the statement viewer (at `page`), a CSV or spreadsheet as a grid, a
 * Word file as a page, a picture as itself. The bytes come from `src`, through the API, which logs the open.
 */
export function DocumentViewer({
  file,
  doc,
  src,
  page,
  mark,
}: {
  file: Viewable
  /** What the statement viewer needs of the document. */
  doc: Pick<DocumentDto, 'id' | 'sensitivity'> & { kind?: string }
  src: string
  page?: number
  /** A PDF's line highlighted by the viewer itself. */
  mark?: StatementMark
}) {
  const name = file.fileName
  return (
    <Suspense fallback={<p className="text-sm text-soft">Opening the file…</p>}>
      {isCsv(file) ? (
        <CsvViewer src={src} downloadName={name} />
      ) : isXlsx(file) ? (
        <SheetViewer src={src} downloadName={name} />
      ) : isDocx(file) ? (
        <DocxViewer src={src} downloadName={name} />
      ) : isImage(file) ? (
        <ImageViewer src={src} type={file.contentType || 'image/png'} downloadName={name} />
      ) : (
        <StatementViewer
          doc={doc}
          src={src}
          page={page}
          mark={mark}
          downloadName={name || undefined}
        />
      )}
    </Suspense>
  )
}
