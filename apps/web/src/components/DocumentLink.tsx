import { useState } from 'react'
import { DOCUMENT_KIND_LABELS, PAYROLL_DOCUMENT_KINDS, type DocumentDto } from '@ad/types'
import { useApi } from '@/hooks/useApi'

/**
 * Opens a document through a short-lived link from the API (which logs the read). With `proofOf`, a payroll proof opens
 * as that item's own copy instead: drawn by the API with only that item's highlights.
 */
export function DocumentLink({
  doc,
  children,
  className = '',
  proofOf,
}: {
  doc: DocumentDto
  children?: React.ReactNode
  className?: string
  proofOf?: { target: 'expense' | 'wex'; id: string }
}) {
  const api = useApi()
  const [error, setError] = useState<string | null>(null)
  const open = async () => {
    try {
      if (proofOf && (PAYROLL_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)) {
        const bytes = await api.bytes(`/payroll/${proofOf.target}/${proofOf.id}/proof/${doc.id}`)
        const url = URL.createObjectURL(new Blob([bytes], { type: doc.contentType }))
        window.open(url, '_blank', 'noopener')
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
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
    </>
  )
}
