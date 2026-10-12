import { useState } from 'react'
import type { DocumentDto, DocumentKind } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { titleCase } from '@/lib/format'
import { Button, ErrorNote, Field, Modal, inputClass } from '@/components/ui'

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
  onDone: () => Promise<void>
}) {
  const api = useApi()
  const existing = waivers[kind] ?? ''
  const [mode, setMode] = useState<'upload' | 'none'>(existing ? 'none' : 'upload')
  const [file, setFile] = useState<File | null>(null)
  const [reason, setReason] = useState(existing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await onDone()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const upload = () =>
    run(async () => {
      if (!file) return
      const form = new FormData()
      form.append('file', file)
      form.append('workspaceId', workspaceId)
      form.append('engagementId', engagementId)
      form.append('kind', kind)
      await api.upload<DocumentDto>('/documents', form)
      // A file on hand means the record exists after all.
      if (existing)
        await api.patch(`/engagements/${engagementId}`, { waivers: { ...waivers, [kind]: '' } })
    })
  const saveReason = () =>
    run(async () => {
      await api.patch(`/engagements/${engagementId}`, {
        waivers: { ...waivers, [kind]: reason.trim() },
      })
    })
  const clearReason = () =>
    run(async () => {
      await api.patch(`/engagements/${engagementId}`, { waivers: { ...waivers, [kind]: '' } })
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
          <span>Upload the {titleCase(kind).toLowerCase()} as it was sent or received.</span>
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
            <span className="font-bold">Document type:</span> {titleCase(kind)}
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
