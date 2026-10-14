import { useState } from 'react'
import {
  DOCUMENT_KIND_LABELS,
  type DocumentDto,
  type DocumentKind,
  type EngagementDetail,
} from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { Button, ErrorNote, Field, Modal, inputClass } from '@/components/ui'
import { kindLabel } from '@/components/AttachModal'

/**
 * What a RecordModal action changed: the engagement as a reason's save answered it, or the uploaded file (which, the
 * same call, ends any reason the kind was missing).
 */
export type RecordChange = { engagement: EngagementDetail } | { added: DocumentDto }

/**
 * One record of an engagement (the proposal, the award letter, the narrative, the contract): upload the
 * file, or say that no such document exists and why. A reason is required; it becomes the record.
 */
export function RecordModal({
  title,
  kind,
  workspaceId,
  engagementId,
  waivers,
  onClose,
  onDone,
}: {
  title: string
  kind: DocumentKind
  workspaceId: string
  engagementId: string
  waivers: Partial<Record<DocumentKind, string>>
  onClose: () => void
  onDone: (change: RecordChange) => void
}) {
  const api = useApi()
  const existing = waivers[kind] ?? ''
  const [mode, setMode] = useState<'upload' | 'none'>(existing ? 'none' : 'upload')
  const [file, setFile] = useState<File | null>(null)
  const [reason, setReason] = useState(existing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<RecordChange | null>) => {
    setBusy(true)
    setError(null)
    try {
      const change = await fn()
      if (change) onDone(change)
      else setBusy(false)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const upload = () =>
    run(async () => {
      if (!file) return null
      const form = new FormData()
      form.append('file', file)
      form.append('workspaceId', workspaceId)
      form.append('engagementId', engagementId)
      form.append('kind', kind)
      // A file on hand means the record exists after all: the reason goes in the same call.
      if (existing) form.append('clearsWaiver', 'true')
      return { added: await api.upload<DocumentDto>('/documents', form) }
    })
  const saveReason = () =>
    run(async () => {
      const engagement = await api.patch<EngagementDetail>(`/engagements/${engagementId}`, {
        waivers: { ...waivers, [kind]: reason.trim() },
      })
      return { engagement }
    })
  const clearReason = () =>
    run(async () => {
      const engagement = await api.patch<EngagementDetail>(`/engagements/${engagementId}`, {
        waivers: { ...waivers, [kind]: '' },
      })
      return { engagement }
    })

  return (
    <Modal title={title} onClose={onClose}>
      <ErrorNote message={error} />
      <div className="ad-kinds mb-4">
        <label className="ad-kind">
          <input
            type="radio"
            name="mode"
            checked={mode === 'upload'}
            onChange={() => setMode('upload')}
          />
          <b>I have the file</b>
          <span>Upload the {DOCUMENT_KIND_LABELS[kind]} as it was sent or received.</span>
        </label>
        <label className="ad-kind">
          <input
            type="radio"
            name="mode"
            checked={mode === 'none'}
            onChange={() => setMode('none')}
          />
          <b>No such document</b>
          <span>This funder skipped it. Say why; the reason is what the auditor gets.</span>
        </label>
      </div>
      {mode === 'upload' ? (
        <div className="grid gap-4">
          <p className="text-sm">
            <span className="font-bold">Document type:</span> {kindLabel(kind)}
          </p>
          <Field label="File" hint="PDF, PNG, JPG, XLSX or DOCX, up to 25 MB" required>
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx"
              className="block w-full text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button kind="primary" onClick={upload} disabled={!file || busy}>
              Upload
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          <Field
            label="Why there is no such document"
            required
            hint="One line is enough, e.g. the funder sent the contract with no letter"
          >
            <textarea
              className={inputClass}
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            {existing && (
              <Button type="button" kind="danger" onClick={clearReason} disabled={busy}>
                Remove this reason
              </Button>
            )}
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button kind="primary" onClick={saveReason} disabled={busy || !reason.trim()}>
              Save reason
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
