import { useState } from 'react'
import {
  BUDGET_FILE_COLUMNS,
  REPORT_LINE_LABELS,
  type BudgetFileAction,
  type BudgetFileDto,
  type BudgetUploadChange,
  type EngagementDetail,
} from '@ad/types'
import { HandCard } from '@/components/HandCard'
import { useApi } from '@/hooks/useApi'
import { recheckWarning } from '@/lib/budget-recheck'
import { money } from '@/lib/format'
import { Button, Chip, ErrorNote, Field, Modal } from '@/components/ui'

const ACTION: Record<BudgetFileAction, React.ReactNode> = {
  new: <Chip tone="ok">New</Chip>,
  change: <Chip tone="accent">Changes</Chip>,
  same: <Chip tone="muted">No change</Chip>,
}

/**
 * Upload the approved budget from an Excel file (GitHub issue #98; owner's decisions, 2026-11-27), laid out as the
 * payroll match offers its zip: how it works with the template, then the file, then what Save will do. The check is
 * read only: the file replaces the whole budget and is kept as the budget history, so a problem is corrected in the
 * file, which is uploaded again. Save sends the file again; nothing is kept until then. Owners and bookkeepers only.
 */
export function BudgetUploadModal({
  engagement: c,
  onClose,
  onSaved,
}: {
  engagement: EngagementDetail
  onClose: () => void
  /** Gets the engagement as saved, with what the upload added, changed and removed. */
  onSaved: (saved: BudgetUploadChange) => void
}) {
  const api = useApi()
  const base = `/engagements/${c.id}/budget-lines`
  const [file, setFile] = useState<File | null>(null)
  const [checked, setChecked] = useState<BudgetFileDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }
  const form = () => {
    const f = new FormData()
    f.append('file', file!)
    return f
  }
  const download = () =>
    run(async () => {
      await api.download(`${base}/file`, `${c.name} - budget.xlsx`)
    })
  const check = () =>
    run(async () => setChecked(await api.upload<BudgetFileDto>(`${base}/file`, form())))
  const save = () =>
    run(async () => onSaved(await api.upload<BudgetUploadChange>(`${base}/upload`, form())))

  if (!checked)
    return (
      <Modal title="Upload budget" onClose={onClose}>
        <ErrorNote message={error} />
        <HandCard
          title="The budget comes from one file"
          icon="📊"
          lead="Upload the approved budget as an Excel file: it replaces the whole budget."
        >
          <ol className="ad-hand-steps">
            <li>
              Download the template.{' '}
              {c.budgetLines.length
                ? 'It already has the current budget lines.'
                : 'Fill in one row for each line of the approved budget.'}
            </li>
            <li>Fill in every cell but the note. Write 0 for an amount of $0.</li>
            <li>Upload it. You check what Save will do before anything is saved.</li>
          </ol>
          <p className="ad-hand-address">
            <span className="ad-hand-address-label">The template&apos;s columns</span>
            <span>{BUDGET_FILE_COLUMNS.join(' · ')}</span>
            <button type="button" onClick={() => void download()} disabled={busy}>
              Download the template
            </button>
          </p>
        </HandCard>
        <Field
          label="Budget file"
          hint="Excel (.xlsx) or CSV, up to 5 MB and 200 lines"
          className="mt-4"
        >
          <input
            type="file"
            accept=".xlsx,.csv"
            className="block w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <div className="mt-6 flex justify-end gap-3">
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button kind="navy" onClick={() => void check()} disabled={!file || busy}>
            Next: check the file
          </Button>
        </div>
      </Modal>
    )

  const { rows, removed, problems } = checked
  const warning = recheckWarning(c)
  const changes = rows.some((r) => r.action !== 'same') || removed.length > 0
  return (
    <Modal title="Check the budget file" onClose={onClose} full>
      <ErrorNote message={error} />
      {problems.length > 0 && (
        <div className="mb-4">
          <ErrorNote
            message={`The file has ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}. Correct ${problems.length === 1 ? 'it' : 'them'} in the file, then upload it again.`}
          />
          <ul className="mt-1 grid gap-1 text-sm text-danger">
            {problems.map((p, i) => (
              <li key={i}>
                {p.row === null ? '' : `Row ${p.row}: `}
                {p.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ad-tablewrap">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Row</th>
              <th>Budget line</th>
              <th>Monthly report line</th>
              <th className="ad-num">Approved amount</th>
              <th>Note</th>
              <th>Save</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.row}>
                <td className="text-sm text-soft">{r.row}</td>
                <td className="font-semibold">{r.name}</td>
                <td className="text-sm">{REPORT_LINE_LABELS[r.reportLine]}</td>
                <td className="ad-num">{money(r.amount)}</td>
                <td className="text-sm">{r.narrative}</td>
                <td>{ACTION[r.action]}</td>
              </tr>
            ))}
            <tr>
              <td></td>
              <td className="font-bold">Total</td>
              <td></td>
              <td className="ad-num font-bold">{money(rows.reduce((t, r) => t + r.amount, 0))}</td>
              <td colSpan={2}></td>
            </tr>
          </tbody>
        </table>
      </div>
      {removed.length > 0 && (
        <p className="mt-3 text-sm">
          <span className="font-semibold">Removed by Save, as the file leaves them out:</span>{' '}
          {removed.join(', ')}
        </p>
      )}
      {problems.length === 0 && !changes && (
        <p className="mt-3 text-sm text-soft">The file matches the budget: Save changes nothing.</p>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        {warning && problems.length === 0 && changes && (
          <span className="max-w-[320px] text-right text-xs text-soft">{warning}</span>
        )}
        <Button
          kind="ghost"
          onClick={() => {
            setChecked(null)
            setFile(null)
          }}
          disabled={busy}
        >
          Upload another file
        </Button>
        <Button kind="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          kind="navy"
          onClick={() => void save()}
          disabled={busy || problems.length > 0 || !changes}
        >
          Save the budget
        </Button>
      </div>
    </Modal>
  )
}
