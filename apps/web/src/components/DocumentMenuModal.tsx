import { useState } from 'react'
import type { DocumentDto, DocumentKind } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { Button, ErrorNote, Field, Modal } from '@/components/ui'
import { kindLabel } from '@/components/AttachModal'

export interface DocumentChange {
  added?: DocumentDto
  removedId: string
}

/** What you can do with a document you already saved: open it, put a newer file in its place, or remove it. */
export function DocumentMenuModal({
  doc,
  canManage,
  replaceWith,
  onClose,
  onChanged,
}: {
  doc: DocumentDto
  canManage: boolean
  /** Where a replacement goes: same place, same kind. */
  replaceWith?: {
    workspaceId: string
    engagementId: string
    kind: DocumentKind
    period: string | null
  }
  onClose: () => void
  /** What changed: the new file in place of this one (`added` and `removedId`), or this one removed. */
  onChanged: (change: DocumentChange) => void
}) {
  const api = useApi()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<DocumentChange | void>) => {
    setBusy(true)
    setError(null)
    try {
      const change = await fn()
      if (change) onChanged(change)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const open = () =>
    run(async () => {
      const { url } = await api.get<{ url: string }>(`/documents/${doc.id}/url`)
      window.open(url, '_blank', 'noopener')
    })
  // One call: the new file and the old one's removal happen together, or not at all.
  const replace = () =>
    run(async () => {
      if (!file || !replaceWith) return
      const form = new FormData()
      form.append('file', file)
      form.append('workspaceId', replaceWith.workspaceId)
      form.append('engagementId', replaceWith.engagementId)
      form.append('kind', replaceWith.kind)
      if (replaceWith.period) form.append('period', replaceWith.period)
      form.append('replaces', doc.id)
      const added = await api.upload<DocumentDto>('/documents', form)
      return { added, removedId: doc.id }
    })
  const remove = () => {
    if (!confirm(`Remove ${doc.fileName}? The file is deleted.`)) return
    void run(async () => {
      await api.del(`/documents/${doc.id}`)
      return { removedId: doc.id }
    })
  }
  return (
    <Modal title={doc.fileName} onClose={onClose}>
      <ErrorNote message={error} />
      <p className="mb-4 text-sm text-soft">
        {kindLabel(doc.kind)} · uploaded {shortDate(doc.uploadedAt)} ·{' '}
        {Math.max(1, Math.round(doc.size / 1024))} KB
        {doc.sensitivity === 'personal'
          ? doc.kind === 'paystub'
            ? ' · personal record, every read logged'
            : ' · personal record, download only, every read logged'
          : ''}
      </p>
      <div className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          <Button kind="primary" onClick={open} disabled={busy}>
            Open
          </Button>
          {canManage && (
            <Button kind="danger" onClick={remove} disabled={busy}>
              Remove
            </Button>
          )}
        </div>
        {canManage && replaceWith && (
          <div className="border-t border-line pt-4">
            <Field
              label="Replace with a newer file"
              hint="The old file is removed once the new one is saved"
            >
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx"
                className="block w-full text-sm"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </Field>
            <div className="mt-3 flex justify-end">
              <Button onClick={replace} disabled={!file || busy}>
                Replace
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
