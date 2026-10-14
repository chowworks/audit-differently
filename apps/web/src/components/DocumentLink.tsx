import { useState } from 'react'
import { DOCUMENT_KIND_LABELS, type DocumentDto } from '@ad/types'
import { useApi } from '@/hooks/useApi'

/** Opens a document through a short-lived link from the API (which logs the read). */
export function DocumentLink({
  doc,
  children,
  className = '',
}: {
  doc: DocumentDto
  children?: React.ReactNode
  className?: string
}) {
  const api = useApi()
  const [error, setError] = useState<string | null>(null)
  const open = async () => {
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
        title={`${DOCUMENT_KIND_LABELS[doc.kind]} · ${doc.fileName}${doc.sensitivity === 'personal' ? ' · personal: download only, logged' : ''}`}
      >
        {children ?? doc.fileName}
      </button>
      {error && <span className="ml-1 text-xs text-danger">{error}</span>}
    </>
  )
}
