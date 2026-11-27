import { useState } from 'react'
import { HandCard } from '@/components/HandCard'
import { Button, ErrorNote, Field, Modal } from '@/components/ui'

/**
 * Bulk Add Names (owner's decision, 2026-11-27): a file is never chosen from a bare button. The dialog says what the
 * file holds in the navy how-to card the payroll match's upload uses (steps, then the columns and the sample in its pill;
 * fictional rows, meant to be replaced), each column explained under it, then the file field and Add names. It closes when
 * the file is read; a refusal stays at its top.
 */
export function BulkAddModal({
  title,
  lead,
  columns,
  note,
  sample,
  onFile,
  onClose,
}: {
  title: string
  /** One line: what the file adds. */
  lead: string
  /** Each column of the sample and what goes in it. */
  columns: [string, string][]
  /** A short line after the columns (what else the file may be). */
  note?: string
  sample: { fileName: string; csv: string }
  /** Reads the file; throws with the server's words when it is refused. */
  onFile: (file: File) => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const add = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await onFile(file)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <ErrorNote message={error} />
      <HandCard title="How it works" icon="📄" lead={lead}>
        <ol className="ad-hand-steps">
          <li>
            Download the sample and fill it in, one row each. Its rows are made up: replace them.
          </li>
          <li>Save it as .csv or .xlsx.</li>
          <li>Select it below, then press Add names. The file is read and never kept.</li>
        </ol>
        {note && <p>{note}</p>}
        <p className="ad-hand-address">
          <span className="ad-hand-address-label">The file&apos;s columns</span>
          <span>{columns.map(([c]) => c).join(' · ')}</span>
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(sample.csv)}`}
            download={sample.fileName}
          >
            Download a sample (CSV)
          </a>
        </p>
      </HandCard>
      <ul className="my-4 grid list-disc gap-1 pl-5 text-sm text-soft">
        {columns.map(([c, what]) => (
          <li key={c}>
            <strong className="text-ink">{c}</strong>: {what}
          </li>
        ))}
      </ul>
      <Field label="Select file to upload" hint=".csv or .xlsx, read and never kept">
        <input
          type="file"
          accept=".csv,.xlsx"
          className="block w-full text-sm"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button kind="navy" onClick={() => void add()} disabled={!file || busy}>
          {busy ? 'Adding…' : 'Add names'}
        </Button>
      </div>
    </Modal>
  )
}
