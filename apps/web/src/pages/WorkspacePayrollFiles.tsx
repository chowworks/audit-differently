import { useState, type ReactNode } from 'react'
import {
  DOCUMENT_KIND_LABELS,
  MAX_WORKSPACE_PAYROLL_FILES,
  type WorkspacePayrollFileDto,
  type WorkspacePayrollFilesDto,
} from '@ad/types'
import { periodLabel, shortDate } from '@/lib/format'
import { PAYROLL_FOLDERS, type PayrollFolderKind } from '@/lib/zip-files'
import { FILE_MAX_BYTES, UploadPanel } from '@/components/PayrollProof'
import { Button, Card, Empty, ErrorNote, Field, inputClass } from '@/components/ui'

export type PayrollUpload = { file: File; kind: PayrollFolderKind }[]

const MAX = MAX_WORKSPACE_PAYROLL_FILES.toLocaleString('en-US')
const kindWord = (k: string) => {
  const w = DOCUMENT_KIND_LABELS[k as keyof typeof DOCUMENT_KIND_LABELS] ?? k
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** What an owner can do to the month's set; each starts a change that is checked and then saved. */
export interface PayrollFilesActions {
  busy: string | null
  /** The server's refusal of the last change started here. */
  error: string | null
  /** A change is open below (unsaved): the set is changed again only once it is saved or discarded. */
  changeOpen: boolean
  /** Each answers true once the change is started, so the panel closes. */
  onReplace: (zip: PayrollUpload) => Promise<boolean>
  onAdd: (files: PayrollUpload) => Promise<boolean>
  onRemove: (f: WorkspacePayrollFileDto) => Promise<boolean>
}

/** Add files: one or more files of one kind, joining the month's set. */
function AddFiles({
  count,
  busy,
  onAdd,
  onCancel,
}: {
  count: number
  busy: string | null
  onAdd: (files: PayrollUpload) => void
  onCancel: () => void
}) {
  const [chosen, setChosen] = useState<File[]>([])
  const [kind, setKind] = useState<PayrollFolderKind | ''>('')
  const big = chosen.filter((f) => f.size > FILE_MAX_BYTES)
  const filesError = big.length
    ? `Over 25 MB: ${big
        .slice(0, 3)
        .map((f) => f.name)
        .join(', ')}${big.length > 3 ? ', …' : ''}`
    : count + chosen.length > MAX_WORKSPACE_PAYROLL_FILES
      ? `The month would hold ${(count + chosen.length).toLocaleString('en-US')} files; the limit is ${MAX}`
      : null
  const kindError = chosen.length > 0 && !kind ? 'Say what these files are' : null
  const toFix = [filesError && 'the files', kindError && 'what they are'].filter(Boolean)
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (chosen.length && kind && !toFix.length) onAdd(chosen.map((file) => ({ file, kind })))
      }}
    >
      {toFix.length > 0 && (
        <p className="ad-field-error-sum" role="status">
          Fix {toFix.join(' and ')} to upload.
        </p>
      )}
      <Field
        label="Files to add"
        required
        error={filesError}
        hint={`PDF, PNG, JPG, XLSX or DOCX, each up to 25 MB. The month holds up to ${MAX} files.`}
      >
        <input
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx"
          className="block w-full text-sm"
          onChange={(e) => setChosen([...(e.target.files ?? [])])}
        />
      </Field>
      <Field
        label="What these files are"
        required
        error={kindError}
        hint="A file of the same name and kind takes the place of the one in the month's files."
      >
        <select
          className={inputClass}
          value={kind}
          onChange={(e) => setKind(e.target.value as PayrollFolderKind | '')}
        >
          <option value="">Choose…</option>
          {PAYROLL_FOLDERS.map(([name, k]) => (
            <option key={k} value={k}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <div className="ad-actions justify-end">
        <Button kind="ghost" onClick={onCancel} disabled={!!busy}>
          Cancel
        </Button>
        <Button
          kind="navy"
          type="submit"
          disabled={!chosen.length || !kind || toFix.length > 0 || !!busy}
        >
          {busy ??
            `Upload ${chosen.length || ''} ${chosen.length === 1 ? 'file' : 'files'} and match`}
        </Button>
      </div>
    </form>
  )
}

/**
 * "<Month> payroll files": the month's one set of payroll files (owner's decision, 2026-10-18). Owners replace it all
 * with a zip, add files, or remove one; each is a change checked and saved below. Auditors read the list.
 */
export function PayrollFilesCard({
  period,
  files,
  error,
  actions,
  title,
  note,
  first,
}: {
  period: string
  files: WorkspacePayrollFilesDto | null
  error: string | null
  /** Owners only. */
  actions?: PayrollFilesActions
  /** The card's own heading, a line under it, and the action before Replace all. */
  title?: string
  note?: ReactNode
  first?: ReactNode
}) {
  const [panel, setPanel] = useState<'replace' | 'add' | null>(null)
  const list = files?.files ?? []
  const can = !!actions && !!files?.can.change && !actions.changeOpen
  const done = (ok: boolean) => ok && setPanel(null)
  return (
    <Card
      title={title ?? `${periodLabel(period)} payroll files`}
      aside={
        can &&
        !panel && (
          <span className="flex flex-wrap gap-2">
            {first}
            <Button kind={first ? 'ghost' : 'navy'} size="sm" onClick={() => setPanel('replace')}>
              Replace all
            </Button>
            <Button kind={first ? 'ghost' : 'primary'} size="sm" onClick={() => setPanel('add')}>
              + Add files
            </Button>
          </span>
        )
      }
    >
      <div className="grid gap-4">
        {note}
        <ErrorNote message={error ?? actions?.error ?? null} />
        {actions?.changeOpen && (
          <p className="text-sm text-soft">
            Save or discard the change below before changing the files again.
          </p>
        )}
        {can && panel === 'replace' && (
          <div className="grid gap-3">
            <p className="text-sm">
              <b>The zip becomes the month&apos;s payroll files.</b> Files not in it leave when you
              save.
            </p>
            <UploadPanel
              existing={0}
              busy={actions.busy}
              maxFiles={MAX_WORKSPACE_PAYROLL_FILES}
              kind="navy"
              action="Upload zip and replace all"
              onReady={(zip) => void actions.onReplace(zip).then(done)}
            />
            <div className="ad-actions justify-start">
              <Button kind="ghost" onClick={() => setPanel(null)} disabled={!!actions.busy}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {can && panel === 'add' && (
          <AddFiles
            count={list.length}
            busy={actions.busy}
            onAdd={(added) => void actions.onAdd(added).then(done)}
            onCancel={() => setPanel(null)}
          />
        )}
        {!files && !error ? (
          <Empty>Loading the files…</Empty>
        ) : list.length === 0 ? (
          <Empty>No payroll files for {periodLabel(period)} yet.</Empty>
        ) : (
          <div className="ad-tablewrap wpc-files">
            <table className="ad-table">
              <thead>
                <tr>
                  <th>File ({list.length.toLocaleString('en-US')})</th>
                  <th>Kind</th>
                  <th>Received</th>
                  {can && <th></th>}
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <tr key={f.id}>
                    <td className="font-semibold">{f.fileName}</td>
                    <td>{kindWord(f.kind)}</td>
                    <td className="whitespace-nowrap">{shortDate(f.uploadedAt)}</td>
                    {can && (
                      <td className="text-right">
                        <button
                          type="button"
                          className="wpc-remove"
                          disabled={!!actions.busy}
                          aria-label={`Remove ${f.fileName} from the month's payroll files`}
                          onClick={() => void actions.onRemove(f)}
                        >
                          remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  )
}
