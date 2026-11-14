import { Suspense, lazy, useState, type ReactNode } from 'react'
import {
  DOCUMENT_KIND_LABELS,
  MAX_WORKSPACE_PAYROLL_FILES,
  type BooksReceiptDto,
  type WorkspacePayrollFileDto,
  type WorkspacePayrollFilesDto,
} from '@ad/types'
import { periodLabel, shortDate } from '@/lib/format'
import { PAYROLL_FOLDERS, type PayrollFolderKind } from '@/lib/zip-files'
import { FILE_MAX_BYTES, UploadPanel } from '@/components/PayrollProof'
import { Button, Card, Empty, ErrorNote, Field, Modal, inputClass } from '@/components/ui'
import { useApi } from '@/hooks/useApi'

/** pdf.js is large: it loads when a file is first viewed. */
const StatementViewer = lazy(() =>
  import('@/components/StatementViewer').then((m) => ({ default: m.StatementViewer }))
)

export type PayrollUpload = { file: File; kind: PayrollFolderKind }[]

const MAX = MAX_WORKSPACE_PAYROLL_FILES.toLocaleString('en-US')
const kindWord = (k: string) => {
  const w = DOCUMENT_KIND_LABELS[k as keyof typeof DOCUMENT_KIND_LABELS] ?? k
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/**
 * The month's files as the zip lays them out: one folder per kind, in the zip's order, each file under its folder by
 * name. A kind the zip has no folder for comes last under its own words.
 */
export function payrollFolders(
  list: WorkspacePayrollFileDto[]
): { name: string; kind: string; files: WorkspacePayrollFileDto[] }[] {
  const byName = (a: WorkspacePayrollFileDto, b: WorkspacePayrollFileDto) =>
    a.fileName.localeCompare(b.fileName, 'en', { numeric: true, sensitivity: 'base' })
  const known = PAYROLL_FOLDERS.map(([name, kind]) => ({
    name,
    kind: kind as string,
    files: list.filter((f) => f.kind === kind).sort(byName),
  }))
  const others = [...new Set(list.map((f) => f.kind as string))]
    .filter((k) => !known.some((f) => f.kind === k))
    .map((k) => ({
      name: kindWord(k),
      kind: k,
      files: list.filter((f) => f.kind === k).sort(byName),
    }))
  return [...known, ...others]
}

/** What an owner can do to the month's set; each starts a change that is checked and then saved. */
export interface PayrollFilesActions {
  busy: string | null
  /** The server's refusal of the last change started here. */
  error: string | null
  /** A change is open below (unsaved): the set is changed again only once it is saved or discarded. */
  changeOpen: boolean
  /** Each answers true once the change is started, so the panel closes. */
  onReplace: (
    zip: PayrollUpload,
    names?: File[],
    mappings?: File[],
    receipts?: File[]
  ) => Promise<boolean>
  onAdd: (files: PayrollUpload) => Promise<boolean>
  onRemove: (f: WorkspacePayrollFileDto) => Promise<boolean>
}

/**
 * The month's receipts (the zip's Receipts folder, emailed or uploaded), shown as one more folder of the month's files
 * (owner's decision, 2026-11-13): each with whether it proves a bill, to view or download, and Add for more.
 */
export interface MonthReceipts {
  workspaceId: string
  period: string
  list: BooksReceiptDto[]
  busy: boolean
  /** Owners only: matched to the month's bills as the zip's are. */
  onAdd?: (files: File[]) => void
}

/** Add files: one or more files into one folder of the month's set. */
function AddFiles({
  count,
  busy,
  folder,
  onAdd,
  onCancel,
}: {
  count: number
  busy: string | null
  /** The folder it was opened from, chosen already. */
  folder?: PayrollFolderKind
  onAdd: (files: PayrollUpload) => void
  onCancel: () => void
}) {
  const [chosen, setChosen] = useState<File[]>([])
  const [kind, setKind] = useState<PayrollFolderKind | ''>(folder ?? '')
  const big = chosen.filter((f) => f.size > FILE_MAX_BYTES)
  const filesError = big.length
    ? `Over 25 MB: ${big
        .slice(0, 3)
        .map((f) => f.name)
        .join(', ')}${big.length > 3 ? ', …' : ''}`
    : count + chosen.length > MAX_WORKSPACE_PAYROLL_FILES
      ? `The month would hold ${(count + chosen.length).toLocaleString('en-US')} files; the limit is ${MAX}`
      : null
  const kindError = chosen.length > 0 && !kind ? 'Choose the folder they go in' : null
  const toFix = [filesError && 'the files', kindError && 'the folder'].filter(Boolean)
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
        label="Folder"
        required
        error={kindError}
        hint="The zip's folder for what these files are. A file of the same name in the folder is replaced."
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
  receipts,
}: {
  /** The month's receipts, as their own folder after the payroll files. */
  receipts?: MonthReceipts
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
  const [folder, setFolder] = useState<PayrollFolderKind | undefined>()
  const [shut, setShut] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<WorkspacePayrollFileDto | null>(null)
  const [viewingReceipt, setViewingReceipt] = useState<BooksReceiptDto | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const api = useApi()
  const list = files?.files ?? []
  /** A file of the set as uploaded, through the API (which logs each open). */
  const fileUrl = (f: WorkspacePayrollFileDto) =>
    `/workspaces/${files!.workspaceId}/payroll/${period}/files/${f.id}/file`
  const receiptUrl = (r: BooksReceiptDto) =>
    `/workspaces/${receipts!.workspaceId}/expenses/${receipts!.period}/receipts/${r.documentId}/file`
  const download = async (f: { fileName: string; contentType?: string }, src: string) => {
    setFileError(null)
    try {
      const bytes = await api.bytes(src)
      const url = URL.createObjectURL(new Blob([bytes], { type: f.contentType }))
      const a = document.createElement('a')
      a.href = url
      a.download = f.fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      setFileError(`${f.fileName} could not be downloaded: ${(e as Error).message}`)
    }
  }
  const addTo = (kind?: PayrollFolderKind) => {
    setFolder(kind)
    setPanel('add')
  }
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
            <Button kind={first ? 'ghost' : 'primary'} size="sm" onClick={() => addTo()}>
              + Add files
            </Button>
          </span>
        )
      }
    >
      <div className="grid gap-4">
        {note}
        <ErrorNote message={error ?? actions?.error ?? fileError} />
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
              takesNames
              kind="navy"
              action="Upload zip and replace all"
              onReady={(zip, _replace, names, mappings, receipts) =>
                void actions.onReplace(zip, names, mappings, receipts).then(done)
              }
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
            folder={folder}
            onAdd={(added) => void actions.onAdd(added).then(done)}
            onCancel={() => setPanel(null)}
          />
        )}
        {!files && !error ? (
          <Empty>Loading the files…</Empty>
        ) : list.length === 0 ? (
          <Empty>No payroll files for {periodLabel(period)} yet.</Empty>
        ) : (
          <ul className="wpc-files wpc-tree" aria-label={`${periodLabel(period)} payroll files`}>
            {payrollFolders(list).map((g) => {
              const open = !shut.has(g.kind)
              const known = PAYROLL_FOLDERS.some(([, k]) => k === g.kind)
              return (
                <li key={g.kind} className="wpc-folder">
                  <div className="wpc-folder-row">
                    <button
                      type="button"
                      className="wpc-folder-name"
                      aria-expanded={open}
                      disabled={!g.files.length}
                      onClick={() =>
                        setShut((was) => {
                          const next = new Set(was)
                          if (open) next.add(g.kind)
                          else next.delete(g.kind)
                          return next
                        })
                      }
                    >
                      <span className="wpc-caret" aria-hidden>
                        {g.files.length ? (open ? '▾' : '▸') : ''}
                      </span>
                      <span className="wpc-folder-icon" aria-hidden />
                      {g.name}
                      <span className="wpc-count">
                        {g.files.length
                          ? `${g.files.length.toLocaleString('en-US')} ${g.files.length === 1 ? 'file' : 'files'}`
                          : 'empty'}
                      </span>
                    </button>
                    {can && known && !panel && (
                      <button
                        type="button"
                        className="wpc-add"
                        disabled={!!actions.busy}
                        aria-label={`Add files to ${g.name}`}
                        onClick={() => addTo(g.kind as PayrollFolderKind)}
                      >
                        + Add
                      </button>
                    )}
                  </div>
                  {open && g.files.length > 0 && (
                    <ul className="wpc-leaves">
                      {g.files.map((f) => (
                        <li key={f.id} className="wpc-leaf">
                          <span className="wpc-leaf-name" title={f.fileName}>
                            {f.fileName}
                          </span>
                          <span className="wpc-leaf-date">{shortDate(f.uploadedAt)}</span>
                          {f.contentType === 'application/pdf' && (
                            <button
                              type="button"
                              className="wpc-open"
                              aria-label={`View ${f.fileName}`}
                              onClick={() => setViewing(f)}
                            >
                              view
                            </button>
                          )}
                          <button
                            type="button"
                            className="wpc-open"
                            aria-label={`Download ${f.fileName}`}
                            onClick={() => void download(f, fileUrl(f))}
                          >
                            download
                          </button>
                          {can && (
                            <button
                              type="button"
                              className="wpc-remove"
                              disabled={!!actions.busy}
                              aria-label={`Remove ${f.fileName} from the month's payroll files`}
                              onClick={() => void actions.onRemove(f)}
                            >
                              remove
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {receipts && (
          <ul className="wpc-files wpc-tree" aria-label={`${periodLabel(period)} receipts`}>
            <li className="wpc-folder">
              <div className="wpc-folder-row">
                <button
                  type="button"
                  className="wpc-folder-name"
                  aria-expanded={!shut.has('receipts')}
                  disabled={!receipts.list.length}
                  onClick={() =>
                    setShut((was) => {
                      const next = new Set(was)
                      if (next.has('receipts')) next.delete('receipts')
                      else next.add('receipts')
                      return next
                    })
                  }
                >
                  <span className="wpc-caret" aria-hidden>
                    {receipts.list.length ? (shut.has('receipts') ? '▸' : '▾') : ''}
                  </span>
                  <span className="wpc-folder-icon" aria-hidden />
                  Receipts
                  <span className="wpc-count">
                    {receipts.list.length
                      ? `${receipts.list.length.toLocaleString('en-US')} ${receipts.list.length === 1 ? 'file' : 'files'}`
                      : 'empty'}
                  </span>
                </button>
                {receipts.onAdd && (
                  <label
                    className={`wpc-add wpc-add-file ${receipts.busy ? 'is-busy' : ''}`}
                    aria-label="Add receipts"
                  >
                    <input
                      type="file"
                      multiple
                      accept=".pdf,.png,.jpg,.jpeg"
                      disabled={receipts.busy}
                      onChange={(ev) => {
                        receipts.onAdd!([...(ev.target.files ?? [])])
                        ev.target.value = ''
                      }}
                    />
                    {receipts.busy ? 'Reading…' : '+ Add'}
                  </label>
                )}
              </div>
              {!shut.has('receipts') && receipts.list.length > 0 && (
                <ul className="wpc-leaves">
                  {[...receipts.list]
                    .sort((a, b) =>
                      a.fileName.localeCompare(b.fileName, 'en', {
                        numeric: true,
                        sensitivity: 'base',
                      })
                    )
                    .map((r) => (
                      <li key={r.documentId} className="wpc-leaf">
                        <span className="wpc-leaf-name" title={r.fileName}>
                          {r.fileName}
                        </span>
                        <span className="wpc-leaf-date">
                          {r.transactionIds.length
                            ? `Proves bill ${r.transactionIds.join(', ')}`
                            : 'Matched to no bill'}
                        </span>
                        {/\.pdf$/i.test(r.fileName) && (
                          <button
                            type="button"
                            className="wpc-open"
                            aria-label={`View ${r.fileName}`}
                            onClick={() => setViewingReceipt(r)}
                          >
                            view
                          </button>
                        )}
                        <button
                          type="button"
                          className="wpc-open"
                          aria-label={`Download ${r.fileName}`}
                          onClick={() => void download(r, receiptUrl(r))}
                        >
                          download
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </li>
          </ul>
        )}
      </div>
      {viewingReceipt && receipts && (
        <Modal title={viewingReceipt.fileName} onClose={() => setViewingReceipt(null)} wide>
          <Suspense fallback={<p className="text-sm text-soft">Opening the receipt…</p>}>
            <StatementViewer
              doc={{ id: viewingReceipt.documentId, sensitivity: 'financial', kind: 'receipt' }}
              src={receiptUrl(viewingReceipt)}
              downloadName={viewingReceipt.fileName}
            />
          </Suspense>
        </Modal>
      )}
      {viewing && files && (
        <Modal title={viewing.fileName} onClose={() => setViewing(null)} wide>
          <Suspense fallback={<p className="text-sm text-soft">Opening the file…</p>}>
            <StatementViewer
              doc={{
                id: viewing.id,
                sensitivity: viewing.personal ? 'personal' : 'financial',
                // The month's payroll files open like the other payroll files, pay stubs too (owner's decision,
                // 2026-10-16).
                kind: viewing.personal ? 'paystub' : viewing.kind,
              }}
              src={fileUrl(viewing)}
              downloadName={viewing.fileName}
            />
          </Suspense>
        </Modal>
      )}
    </Card>
  )
}
