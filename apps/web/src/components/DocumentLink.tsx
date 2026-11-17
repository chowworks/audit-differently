import { useState } from 'react'
import { createPortal } from 'react-dom'
import { DOCUMENT_KIND_LABELS, PAYROLL_DOCUMENT_KINDS, type DocumentDto } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { Modal } from '@/components/ui'
import { DocumentViewer, canView } from '@/components/DocumentViewer'

/**
 * Opens a document in the app's viewer (PDF, picture, CSV, spreadsheet or Word file), from its bytes through the API,
 * which logs the open. With `proofOf`, a payroll proof opens as that item's own copy instead, drawn by the API with only
 * that item's highlights. Every viewer has Download under the file's own name. A type the app cannot show opens from
 * its short-lived link.
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
  const open = async () => {
    if (canView(doc)) return setViewing(true)
    try {
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
        title={`${DOCUMENT_KIND_LABELS[doc.kind]} · ${doc.fileName}${doc.sensitivity === 'personal' ? ' · personal: every read logged' : ''}`}
      >
        {children ?? doc.fileName}
      </button>
      {error && <span className="ml-1 text-xs text-danger">{error}</span>}
      {viewing &&
        // At the page, not inside the table cell the link sits in.
        createPortal(
          <Modal
            title={`${DOCUMENT_KIND_LABELS[doc.kind].replace(/^./, (c) => c.toUpperCase())}: ${doc.fileName}`}
            onClose={() => setViewing(false)}
            wide
          >
            <DocumentViewer
              file={doc}
              doc={doc}
              src={copy || `/documents/${doc.id}/file`}
              page={page}
            />
          </Modal>,
          document.body
        )}
    </>
  )
}
