import { useState } from 'react'
import { DOCUMENT_KINDS, type DocumentDto, type DocumentKind } from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { shortDate, titleCase } from '@/lib/format'
import { Button, ErrorNote, Field, Modal, inputClass } from '@/components/ui'

/**
 * Attach a document: upload a new file, or pick one the workspace already holds (a bank statement covers
 * several expenses, a payroll register covers every participant).
 */
export function AttachModal({
  title,
  workspaceId,
  engagementId,
  period,
  defaultKind,
  kinds,
  uploadOnly,
  onClose,
  onPick,
}: {
  title: string
  workspaceId: string
  engagementId: string
  period: string | null
  defaultKind: DocumentKind
  /** The document types that make sense here; one means no choice to make. */
  kinds?: DocumentKind[]
  /** A record of the engagement itself (award letter, signed report): a new file, no picking from the library. */
  uploadOnly?: boolean
  onClose: () => void
  onPick: (documentId: string) => Promise<void>
}) {
  const api = useApi()
  const { data: docs } = useLoad<DocumentDto[]>(
    uploadOnly ? null : `/documents/of-workspace/${workspaceId}`
  )
  const options: DocumentKind[] = kinds?.length ? kinds : [...DOCUMENT_KINDS]
  const [kind, setKind] = useState<DocumentKind>(defaultKind)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const upload = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('workspaceId', workspaceId)
      form.append('engagementId', engagementId)
      form.append('kind', kind)
      if (period) form.append('period', period)
      const doc = await api.upload<DocumentDto>('/documents', form)
      await onPick(doc.id)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const pick = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await onPick(id)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  // The likeliest picks first: this month's documents, then the kind being attached, then newest.
  const rank = (d: DocumentDto) => (d.period === period ? 0 : 2) + (d.kind === defaultKind ? 0 : 1)
  const visible = (docs ?? [])
    .filter(
      (d) =>
        !filter ||
        `${d.fileName} ${d.kind} ${d.period ?? ''}`.toLowerCase().includes(filter.toLowerCase())
    )
    .sort((a, b) => rank(a) - rank(b))

  return (
    <Modal title={title} onClose={onClose} wide={!uploadOnly}>
      <ErrorNote message={error} />
      <div className={`grid gap-6 ${uploadOnly ? '' : 'md:grid-cols-2'}`}>
        <div>
          <h3 className="ad-group-title">Upload a file</h3>
          {options.length === 1 ? (
            <p className="text-sm">
              <span className="font-bold">Document type:</span> {titleCase(options[0])}
            </p>
          ) : (
            <Field label="Document type">
              <select
                className={inputClass}
                value={kind}
                onChange={(e) => setKind(e.target.value as DocumentKind)}
              >
                {options.map((k) => (
                  <option key={k} value={k}>
                    {titleCase(k)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="File" hint="PDF, PNG, JPG, XLSX or DOCX, up to 25 MB" className="mt-3">
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx"
              className="block w-full text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <Button kind="primary" className="mt-4" onClick={upload} disabled={!file || busy}>
            Upload and attach
          </Button>
        </div>
        {!uploadOnly && (
          <div>
            <h3 className="ad-group-title">Or pick one already uploaded</h3>
            <input
              className={`${inputClass} mb-2`}
              placeholder="Filter by name, kind or month"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-card border border-line">
              {visible.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-alt disabled:opacity-50"
                    onClick={() => pick(d.id)}
                    disabled={busy}
                  >
                    <span>
                      <span className="font-semibold">{d.fileName}</span>
                      <span className="block text-xs text-soft">
                        {d.kind.replace(/-/g, ' ')}
                        {d.period ? ` · ${d.period}` : ''} · {shortDate(d.uploadedAt)}
                      </span>
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wide text-accent">
                      attach
                    </span>
                  </button>
                </li>
              ))}
              {visible.length === 0 && <li className="ad-empty">Nothing uploaded yet.</li>}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
