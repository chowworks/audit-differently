import { useState } from 'react'
import {
  REPORT_LINE_LABELS,
  type MatchSuggestion,
  type ReceiptDto,
  type ReceiptInput,
  type ReceiptUploadResult,
  type ReportDetail,
} from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { money, shortDate } from '@/lib/format'
import { DocumentLink } from '@/components/DocumentLink'
import { kindLabel } from '@/components/AttachModal'
import { HandCard } from '@/components/HandCard'
import { MatchPairs, type MatchKit } from '@/components/MatchPairs'
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Modal,
  MoneyInput,
  inputClass,
} from '@/components/ui'

/** Why a suggestion fits, in a few words: "exact amount · same day · vendor matches". */
function why(s: MatchSuggestion): string {
  const parts: string[] = []
  if (s.amount === 'exact') parts.push('exact amount')
  if (s.amount === 'within-a-cent') parts.push('amount a cent off')
  if (s.daysApart === 0) parts.push('same day')
  else if (s.daysApart != null)
    parts.push(`${s.daysApart} day${s.daysApart === 1 ? '' : 's'} apart`)
  if (s.vendor >= 0.99) parts.push('vendor matches')
  else if (s.vendor > 0) parts.push('vendor alike')
  return parts.join(' · ')
}

/** What was read from a receipt, on one line: "Bright Path Office Supply · Sep 2, 2026 · $212.18". */
function readLine(r: ReceiptDto): string {
  const parts = [
    r.vendor,
    r.date ? shortDate(r.date) : null,
    r.amount == null ? null : money(r.amount),
  ]
  const shown = parts.filter(Boolean).join(' · ')
  return shown || 'Nothing read yet: add the amount, date and vendor'
}

/**
 * The month's receipts beside its ledger, as banking software matches transactions: upload many at once, check what
 * was read, confirm a suggested match (the receipt becomes the expense's invoice proof), unmatch, or set a receipt
 * aside as not for this grant. Every answer is the month's page as it now stands.
 */
export function MatchReceipts({
  report: r,
  onChange,
  onNotice,
}: {
  report: ReportDetail
  onChange: (report: ReportDetail) => void
  onNotice: (text: string) => void
}) {
  const api = useApi()
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState<ReceiptDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { receipts, suggestions } = r.matching
  const unmatched = receipts.filter((x) => !x.dismissed && x.matchedTo.length === 0)
  const matched = receipts.filter((x) => x.matchedTo.length > 0)
  const setAside = receipts.filter((x) => x.dismissed)
  const open = r.expenses.filter((e) => !e.documents.some((d) => d.purpose === 'invoice'))
  const expense = (id: string) => r.expenses.find((e) => e.id === id)

  const run = async (fn: () => Promise<ReportDetail>, ok: string) => {
    setBusy(true)
    setError(null)
    try {
      onChange(await fn())
      onNotice(ok)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const kit: MatchKit = {
    r,
    unmatched,
    open,
    suggestions,
    busy,
    match: (x, expenseId) =>
      run(
        () => api.post<ReportDetail>(`/receipts/${x.document.id}/match`, { expenseId }),
        `Matched to expense ${expense(expenseId)?.itemNumber ?? ''}.`
      ),
    dismiss: (x) =>
      run(
        () => api.post<ReportDetail>(`/receipts/${x.document.id}/dismiss`, { dismissed: true }),
        'Set aside as not for this grant.'
      ),
    edit: setEditing,
    readLine,
    why,
  }
  // What is matched, receipt beside the expense it proves, with the expense in full: who, how much, when, which line.
  const matchedList = (
    <ul className="mx-list">
      {matched.map((x) =>
        x.matchedTo.map((m) => {
          const e = expense(m.expenseId)
          return (
            <li key={`${x.document.id}-${m.expenseId}`} className="mx-pair mx-pair-done">
              <div className="mx-receipt">
                <span className="mx-receipt-icon" aria-hidden="true">
                  🧾
                </span>
                <div>
                  <DocumentLink doc={x.document} />
                  <span className="ad-table-sub">{readLine(x)}</span>
                </div>
              </div>
              <span className="mx-arrow mx-arrow-done" aria-hidden="true">
                ✓
              </span>
              <div>
                {e ? (
                  <>
                    <b>{e.vendor}</b> · {money(e.totalCost)} · {shortDate(e.date)}
                    <span className="ad-table-sub">
                      Item <span className="ad-mono">{e.itemNumber}</span> ·{' '}
                      {REPORT_LINE_LABELS[e.reportLine]}
                      {e.memo ? ` · ${e.memo}` : ''}
                    </span>
                  </>
                ) : (
                  <>
                    Expense <span className="ad-mono">{m.itemNumber}</span>
                    <span className="ad-table-sub">In another month</span>
                  </>
                )}
              </div>
              {r.can.edit && e ? (
                <Button
                  kind="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        api.del<ReportDetail>(`/receipts/${x.document.id}/match/${m.expenseId}`),
                      `Unmatched from expense ${m.itemNumber}.`
                    )
                  }
                >
                  unmatch
                </Button>
              ) : (
                <span />
              )}
            </li>
          )
        })
      )}
    </ul>
  )

  return (
    <Card
      className="mt-4"
      title="Match receipts"
      aside={
        <>
          <span className="text-xs text-soft">
            {unmatched.length} unmatched · {matched.length} matched
            {open.length
              ? ` · ${open.length} expense${open.length === 1 ? '' : 's'} without an invoice or receipt`
              : ''}
          </span>
          {r.can.edit && (
            <Button kind="primary" onClick={() => setUploading(true)} data-testid="upload-receipts">
              Upload receipts
            </Button>
          )}
        </>
      }
    >
      <ErrorNote message={error} />
      <div className="mb-4">
        <HandCard
          title="Email receipts in"
          icon="📬"
          lead={
            r.matching.receiptsEmail
              ? 'Forward receipts to your workspace’s email. Include the grant code in the subject. Automatically matched.'
              : 'Your workspace can take receipts by email once an owner sets its address.'
          }
        >
          {r.matching.receiptsEmail ? (
            <>
              <CopyPill label="Email" value={r.matching.receiptsEmail} />
              {r.engagement.code && <CopyPill label="Subject" value={r.engagement.code} />}
              <ol className="ad-hand-steps">
                <li>Send from your sign-in email.</li>
                <li>Attach a PDF or photo.</li>
                <li>No match? It waits here.</li>
              </ol>
            </>
          ) : (
            <p>An owner sets it under the workspace’s Settings, once.</p>
          )}
        </HandCard>
      </div>
      {receipts.length === 0 && (
        <Empty>
          No receipts uploaded to this month yet. Upload them all at once: each is read for its
          amount, date and vendor and matched to its expense when only one fits.
        </Empty>
      )}

      {unmatched.length > 0 && (
        <section className="mx-work" aria-label="To match">
          <h3 className="mx-work-title">
            To match <span className="mx-count">{unmatched.length}</span>
          </h3>
          <MatchPairs k={kit} />
        </section>
      )}
      {receipts.length > 0 && unmatched.length === 0 && (
        <Empty>Auto-matching, matched every receipt.</Empty>
      )}

      {(matched.length > 0 || setAside.length > 0) && (
        <section className="mx-panel" aria-label="Already handled">
          {matched.length > 0 && (
            <details>
              <summary>
                <span className="mx-chevron" aria-hidden="true">
                  ▸
                </span>
                <span className="mx-panel-title">Review the {matched.length} matched</span>
                <span className="text-sm text-soft">
                  Each receipt beside the expense it proves.
                </span>
                <span className="mx-toggle" aria-hidden="true">
                  <span className="mx-toggle-show">Show</span>
                  <span className="mx-toggle-hide">Hide</span>
                </span>
              </summary>
              {matchedList}
            </details>
          )}
          {setAside.length > 0 && (
            <details>
              <summary>
                <span className="mx-chevron" aria-hidden="true">
                  ▸
                </span>
                <span className="mx-panel-title">
                  {setAside.length} set aside as not for this grant
                </span>
                <span className="mx-toggle" aria-hidden="true">
                  <span className="mx-toggle-show">Show</span>
                  <span className="mx-toggle-hide">Hide</span>
                </span>
              </summary>
              <ul className="mx-list">
                {setAside.map((x) => (
                  <li key={x.document.id} className="mx-row">
                    <span>
                      <DocumentLink doc={x.document} />
                      <span className="ad-table-sub">{readLine(x)}</span>
                    </span>
                    {r.can.edit && (
                      <Button
                        kind="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () =>
                              api.post<ReportDetail>(`/receipts/${x.document.id}/dismiss`, {
                                dismissed: false,
                              }),
                            'Back among the unmatched receipts.'
                          )
                        }
                      >
                        bring back
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {uploading && (
        <UploadReceiptsModal
          reportId={r.id}
          aiAvailable={r.matching.aiAvailable}
          onClose={() => setUploading(false)}
          onUploaded={(result) => {
            setUploading(false)
            onChange(result.report)
            onNotice(
              `Uploaded ${result.uploaded} receipt${result.uploaded === 1 ? '' : 's'}; ${result.matched} matched automatically.`
            )
          }}
        />
      )}
      {editing && (
        <EditReceiptModal
          receipt={editing}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            onChange(await api.patch<ReportDetail>(`/receipts/${editing.document.id}`, input))
            setEditing(null)
            onNotice('Receipt details saved.')
          }}
        />
      )}
    </Card>
  )
}

/** A value to paste somewhere else (the receipts email, the grant code), in its pill with a Copy button. */
function CopyPill({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <p className="ad-hand-address">
      <span className="ad-hand-address-label">{label}</span>
      <span className="ad-mono">{value}</span>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </p>
  )
}

function UploadReceiptsModal({
  reportId,
  aiAvailable,
  onClose,
  onUploaded,
}: {
  reportId: string
  /** The server can read receipts with AI: the box is shown, unticked each time the dialog opens. */
  aiAvailable: boolean
  onClose: () => void
  onUploaded: (result: ReceiptUploadResult) => void
}) {
  const api = useApi()
  const [files, setFiles] = useState<File[]>([])
  // Never remembered: unticked every time the dialog opens.
  const [withAi, setWithAi] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const upload = async () => {
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      for (const f of files) form.append('files', f)
      // Filed as receipts: an invoice uploaded here proves the same thing, so the screen asks no document type.
      form.append('kind', 'receipt')
      if (withAi) form.append('ai', 'true')
      onUploaded(await api.upload<ReceiptUploadResult>(`/reports/${reportId}/receipts`, form))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title="Upload receipts" onClose={onClose}>
      <ErrorNote message={error} />
      <Field label="Receipts or invoices" hint="PDF, PNG or JPG, up to 20 at a time, 10 MB each">
        <input
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg"
          className="block w-full text-sm"
          onChange={(e) => setFiles([...(e.target.files ?? [])])}
        />
      </Field>
      {aiAvailable && (
        <div className="ad-ai-optin mt-3">
          <span className="ad-ai-tag">✨ Optional AI Automation</span>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} />
            Read the amount, date and vendor with AI
          </label>
          <small className="text-soft">
            Sends these receipt files to an AI model when a PDF&apos;s text does not give all three.
            Only receipts and invoices, never personal documents.
          </small>
        </div>
      )}
      <p className="mt-3 text-xs text-soft">
        {withAi
          ? 'Each file is read for its amount, date and vendor'
          : "Each PDF is read from its text for its amount, date and vendor (type what it can't read)"}{' '}
        and matched to its expense when exactly one fits. Check the rest below.
      </p>
      <Button kind="primary" className="mt-4" onClick={upload} disabled={!files.length || busy}>
        {busy
          ? 'Uploading…'
          : `Upload ${files.length || ''} ${files.length === 1 ? 'file' : 'files'}`}
      </Button>
    </Modal>
  )
}

function EditReceiptModal({
  receipt,
  onClose,
  onSave,
}: {
  receipt: ReceiptDto
  onClose: () => void
  onSave: (input: ReceiptInput) => Promise<void>
}) {
  const [amount, setAmount] = useState<number | null>(receipt.amount)
  const [date, setDate] = useState(receipt.date ?? '')
  const [vendor, setVendor] = useState(receipt.vendor ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave({ amount, date: date || null, vendor: vendor.trim() || null })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      title={`${kindLabel(receipt.document.kind)}: ${receipt.document.fileName}`}
      onClose={onClose}
    >
      <ErrorNote message={error} />
      <Field label="Amount">
        <MoneyInput value={amount} onChange={setAmount} />
      </Field>
      <Field label="Date" className="mt-3">
        <input
          type="date"
          className={inputClass}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
      <Field label="Vendor" className="mt-3">
        <input
          className={inputClass}
          maxLength={200}
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
        />
      </Field>
      <Button kind="primary" className="mt-4" onClick={save} disabled={busy}>
        Save
      </Button>
    </Modal>
  )
}
