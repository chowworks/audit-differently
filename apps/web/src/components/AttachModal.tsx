import { useState } from 'react'
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  type DocumentDto,
  type DocumentKind,
  type DocumentPurpose,
  type ReportDetail,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { Button, ErrorNote, Field, Modal, inputClass } from '@/components/ui'

/** A document kind as the screens and the access log name it, starting a label: "MOU", "Pay stub". */
export const kindLabel = (k: DocumentKind) => {
  const word = DOCUMENT_KIND_LABELS[k]
  return word[0]!.toUpperCase() + word.slice(1)
}

/** The proof slot a document goes into: an expense's or a work-experience payment's. */
export interface AttachTarget {
  target: 'expense' | 'wex'
  id: string
  purpose: DocumentPurpose
}

/**
 * Attach a document: upload a new file, or pick one the workspace already holds (a bank statement covers
 * several expenses, a payroll register covers every participant). With `attachTo`, either is one call that
 * files the document in that slot and answers with the month's page; without it, a plain upload.
 */
export function AttachModal({
  title,
  workspaceId,
  engagementId,
  period,
  defaultKind,
  kinds,
  uploadOnly,
  attachTo,
  onClose,
  onPick,
  onAttached,
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
  attachTo?: AttachTarget
  onClose: () => void
  /** After a plain upload (no `attachTo`). */
  onPick?: (doc: DocumentDto) => Promise<void>
  /** After the document went into the `attachTo` slot, with the month's page as it now stands. */
  onAttached?: (report: ReportDetail) => Promise<void>
}) {
  const api = useApi()
  // The list is a read of the workspace's documents, logged; `for` and `id` only word that line.
  const listPath = attachTo
    ? `/documents/of-workspace/${workspaceId}?for=${attachTo.target}&id=${encodeURIComponent(attachTo.id)}`
    : `/documents/of-workspace/${workspaceId}`
  const picking = !uploadOnly && !!attachTo
  const { data: docs } = useLoad<DocumentDto[]>(picking ? listPath : null)
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
      if (attachTo) {
        form.append('attachTo', attachTo.target)
        form.append('attachId', attachTo.id)
        form.append('purpose', attachTo.purpose)
      }
      const doc = await api.upload<DocumentDto & { report?: ReportDetail }>('/documents', form)
      if (attachTo && doc.report) await onAttached?.(doc.report)
      else await onPick?.(doc)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const pick = async (id: string) => {
    if (!attachTo) return
    setBusy(true)
    setError(null)
    try {
      const report = await api.post<ReportDetail>(
        `/${attachTo.target === 'expense' ? 'expenses' : 'wex'}/${attachTo.id}/documents`,
        { documentId: id, purpose: attachTo.purpose }
      )
      await onAttached?.(report)
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
        `${d.fileName} ${DOCUMENT_KIND_LABELS[d.kind]} ${d.period ?? ''}`
          .toLowerCase()
          .includes(filter.toLowerCase())
    )
    .sort((a, b) => rank(a) - rank(b))

  return (
    <Modal title={title} onClose={onClose} wide={picking}>
      <ErrorNote message={error} />
      <div className={`grid gap-6 ${picking ? 'md:grid-cols-2' : ''}`}>
        <div>
          <h3 className="ad-group-title">Upload a file</h3>
          {options.length === 1 ? (
            <p className="text-sm">
              <span className="font-bold">Document type:</span> {kindLabel(options[0]!)}
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
                    {kindLabel(k)}
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
            {attachTo ? 'Upload and attach' : 'Upload'}
          </Button>
        </div>
        {picking && (
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
                        {kindLabel(d.kind)}
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
