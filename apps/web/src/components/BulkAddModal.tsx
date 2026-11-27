import { useState } from 'react'
import { Button, ErrorNote, Modal } from '@/components/ui'

/**
 * Bulk Add Names (owner's decision, 2026-11-27): a file is never chosen from a bare button. The dialog says what the
 * file holds, column by column, offers a sample to download and fill in (fictional rows, meant to be replaced), and only
 * then the file picker. It closes when the file is read; a refusal stays at its top.
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
  const download = () => {
    const url = URL.createObjectURL(new Blob([sample.csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = sample.fileName
    a.click()
    URL.revokeObjectURL(url)
  }
  const choose = async (file: File | undefined) => {
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
      <p className="mb-3 font-bold">{lead}</p>
      <ol className="mb-4 grid list-decimal gap-3 pl-5 text-sm">
        <li>
          Download the sample and fill it in, one row each. Its rows are made up: replace them.
          <ul className="mt-1 list-disc pl-5 text-soft">
            {columns.map(([c, what]) => (
              <li key={c}>
                <strong className="text-ink">{c}</strong>: {what}
              </li>
            ))}
          </ul>
          {note && <p className="mt-1 text-soft">{note}</p>}
          <Button kind="navy" size="sm" className="mt-2" onClick={download}>
            Download the sample (CSV)
          </Button>
        </li>
        <li>Save it as .csv or .xlsx, then choose it. The file is read and never kept.</li>
      </ol>
      <div className="flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>
          Cancel
        </Button>
        <label
          className={`ad-btn ad-btn-navy cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 ${busy ? 'opacity-60' : ''}`}
        >
          {busy ? 'Reading the file…' : 'Choose your file'}
          <input
            type="file"
            accept=".xlsx,.csv"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              void choose(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
      </div>
    </Modal>
  )
}
