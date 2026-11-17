import { Suspense, lazy, useState } from 'react'
import { createPortal } from 'react-dom'
import { DOCUMENT_KIND_LABELS, PAYROLL_DOCUMENT_KINDS, type DocumentDto } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { isCsv, isXlsx } from '@/lib/format'
import { Modal } from '@/components/ui'

/** pdf.js is large: it loads when a proof is first shown. */
const StatementViewer = lazy(() =>
  import('@/components/StatementViewer').then((m) => ({ default: m.StatementViewer }))
)
const CsvViewer = lazy(() =>
  import('@/components/CsvViewer').then((m) => ({ default: m.CsvViewer }))
)
const SheetViewer = lazy(() =>
  import('@/components/SheetViewer').then((m) => ({ default: m.SheetViewer }))
)

/**
 * Opens a document through a short-lived link from the API (which logs the read). With `proofOf`, a payroll proof opens
 * as that item's own copy instead, drawn by the API with only that item's highlights: a PDF in the in-app viewer, with
 * Download under its own name (a browser tab of it would save under a made-up one), a CSV or a spreadsheet (payroll
 * details, the books' export behind an allocation worksheet) as a table in the same way; another file downloads under
 * its name. Any other spreadsheet opens in the same viewer from its own bytes (an xlsx link would only download it),
 * unless it is a personal record, which stays a download.
 */
export function DocumentLink({
  doc,
  children,
  className = '',
  proofOf,
  page,
}: {
  doc: DocumentDto
  children?: React.ReactNode
  className?: string
  proofOf?: { target: 'expense' | 'wex'; id: string }
  /** The page a PDF opens at in the viewer: where its highlight is. */
  page?: number
}) {
  const api = useApi()
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState(false)
  const copy =
    proofOf &&
    (PAYROLL_DOCUMENT_KINDS as readonly string[]).includes(doc.kind) &&
    `/payroll/${proofOf.target}/${proofOf.id}/proof/${doc.id}`
  // Any other spreadsheet a person may open (not a record that opens only as a download): its bytes through the API,
  // shown in the same viewer, since its link would only download it.
  const sheet =
    !copy &&
    isXlsx(doc) &&
    (doc.sensitivity !== 'personal' || doc.kind === 'paystub') &&
    `/documents/${doc.id}/file`
  const src = copy || sheet
  const open = async () => {
    try {
      if (sheet) return setViewing(true)
      if (copy) {
        if (doc.contentType === 'application/pdf' || isCsv(doc) || isXlsx(doc))
          return setViewing(true)
        const bytes = await api.bytes(copy)
        const url = URL.createObjectURL(new Blob([bytes], { type: doc.contentType }))
        const a = document.createElement('a')
        a.href = url
        a.download = doc.fileName
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        return
      }
      const { url } = await api.get<{ url: string }>(`/documents/${doc.id}/url`)
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={open}
        className={`cursor-pointer border-0 bg-transparent p-0 font-semibold text-accent hover:underline ${className}`}
        title={`${DOCUMENT_KIND_LABELS[doc.kind]} · ${doc.fileName}${doc.sensitivity === 'personal' ? ' · personal: download only, logged' : ''}`}
      >
        {children ?? doc.fileName}
      </button>
      {error && <span className="ml-1 text-xs text-danger">{error}</span>}
      {viewing &&
        src &&
        // At the page, not inside the table cell the link sits in.
        createPortal(
          <Modal
            title={`${DOCUMENT_KIND_LABELS[doc.kind].replace(/^./, (c) => c.toUpperCase())}: ${doc.fileName}`}
            onClose={() => setViewing(false)}
            wide
          >
            <Suspense fallback={<p className="text-sm text-soft">Opening the file…</p>}>
              {isCsv(doc) ? (
                <CsvViewer src={src} downloadName={doc.fileName} />
              ) : isXlsx(doc) ? (
                <SheetViewer src={src} downloadName={doc.fileName} />
              ) : (
                <StatementViewer doc={doc} src={src} page={page} downloadName={doc.fileName} />
              )}
            </Suspense>
          </Modal>,
          document.body
        )}
    </>
  )
}
