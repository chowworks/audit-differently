import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { type ClosingInput, type ReportDetail } from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import { periodLabel, shortDate } from '@/lib/format'
import {
  Button,
  Card,
  Chip,
  Empty,
  ErrorNote,
  Field,
  Modal,
  Notice,
  inputClass,
} from '@/components/ui'
import { DocumentLink } from '@/components/DocumentLink'
import { AttachModal } from '@/components/AttachModal'
import { ImportTransactionsModal } from '@/components/ImportTransactionsModal'
import { MatchReceipts } from '@/components/MatchReceipts'
import { PayrollProof } from '@/components/PayrollProof'
import { LayoutC } from './report-layouts/LayoutC'
import { useRowEditing } from './report-layouts/row-editing'

export function ReportPage() {
  const { id } = useParams()
  const api = useApi()
  // The open is the one logged read; each change answers with the page as it now stands, so nothing re-fetches.
  const { data: r, error, setData } = useLoad<ReportDetail>(id ? `/reports/${id}` : null)
  const [importing, setImporting] = useState(false)
  const [closing, setClosing] = useState<
    'approve' | 'send-back' | 'request-edits' | 'reopen' | null
  >(null)
  const [signing, setSigning] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const run = async (fn: () => Promise<ReportDetail>, ok?: string) => {
    setBusy(true)
    setNotice(null)
    try {
      setData(await fn())
      if (ok) setNotice({ tone: 'ok', text: ok })
    } catch (e) {
      setNotice({ tone: 'danger', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  // A row's dialogs (edit, attach, remove), shared with the month end page so a row changes the same way there.
  const rows = useRowEditing({
    onChange: setData,
    onNotice: setNotice,
    run: (fn, ok) => void run(fn, ok),
  })

  useEffect(() => {
    if (!highlight) return
    document
      .getElementById(`expense-${highlight}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = setTimeout(() => setHighlight(null), 2500)
    return () => clearTimeout(t)
  }, [highlight])

  if (error) return <ErrorNote message={error} />
  if (!r) return <Empty>Loading…</Empty>

  const act = rows.forMonth(r)
  const submit = () =>
    run(
      async () => {
        try {
          return await api.post<ReportDetail>(`/reports/${r.id}/submit`)
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) throw new Error(e.message)
          throw e
        }
      },
      `${periodLabel(r.period)} submitted to ${r.engagement.funder ?? 'the funder'}.`
    )
  const downloadBundle = async () => {
    setBusy(true)
    setNotice(null)
    try {
      await api.download(
        `/reports/${r.id}/bundle`,
        `${r.engagement.name} - ${periodLabel(r.period)} - bundle.zip`
      )
      setNotice({
        tone: 'ok',
        text: "Month's bundle downloaded. The download is in the access log.",
      })
    } catch (e) {
      setNotice({ tone: 'danger', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  /** An empty month: nothing to submit, so an owner deletes it, after a yes, and lands on its engagement. */
  const deleteMonth = async () => {
    if (
      !confirm(
        `Delete ${periodLabel(r.period)}? It has no expenses, no payroll and no files, so there is nothing to submit. You can start it again later.`
      )
    )
      return
    setBusy(true)
    try {
      const { engagementId } = await api.del<{ engagementId: string }>(`/reports/${r.id}`)
      navigate(`/engagements/${engagementId}`)
    } catch (e) {
      setNotice({ tone: 'danger', text: (e as Error).message })
      setBusy(false)
    }
  }

  const receiptsCard = (
    <MatchReceipts
      report={r}
      onChange={setData}
      onNotice={(text) => setNotice({ tone: 'ok', text })}
    />
  )
  const payrollProofCard = (
    <PayrollProof
      report={r}
      onChange={setData}
      onNotice={(text) => setNotice({ tone: 'ok', text })}
    />
  )
  const earlier = r.reopenings.length > 0 && <EarlierSubmissions report={r} />
  const modals = (
    <>
      {importing && (
        <ImportTransactionsModal
          engagementId={r.engagement.id}
          reportId={r.id}
          onClose={() => setImporting(false)}
          onImported={(result) => result.report && setData(result.report)}
        />
      )}
      {rows.modals}
      {signing && (
        <AttachModal
          title={`Signed report for ${periodLabel(r.period)}`}
          workspaceId={r.engagement.workspace.id}
          engagementId={r.engagement.id}
          period={r.period}
          defaultKind="signed-report"
          kinds={['signed-report']}
          uploadOnly
          onClose={() => setSigning(false)}
          onPick={async (doc) => {
            setSigning(false)
            // The upload's answer is the new document; the page adds it without asking again.
            setData({
              ...r,
              documents: [doc, ...r.documents],
              signedCopy: doc,
              can: { ...r.can, attachSigned: false },
            })
            setNotice({ tone: 'ok', text: 'Signed copy on file.' })
          }}
        />
      )}
      {closing === 'approve' && (
        <ClosingModal
          report={r}
          onClose={() => setClosing(null)}
          onSave={async (body) => {
            setData(await api.post<ReportDetail>(`/reports/${r.id}/closing`, body))
            setClosing(null)
            setNotice({
              tone: 'ok',
              text: `Month-end closing of ${periodLabel(r.period)} recorded as approved.`,
            })
          }}
        />
      )}
      {closing === 'send-back' && (
        <SendBackModal
          report={r}
          onClose={() => setClosing(null)}
          onSave={async (reason) => {
            setData(await api.post<ReportDetail>(`/reports/${r.id}/send-back`, { reason }))
            setClosing(null)
            setNotice({
              tone: 'ok',
              text: `Month-end closing of ${periodLabel(r.period)} sent back. The month is a draft again.`,
            })
          }}
        />
      )}
      {closing === 'request-edits' && (
        <RequestEditsModal
          report={r}
          onClose={() => setClosing(null)}
          onSave={async (comment) => {
            setData(await api.post<ReportDetail>(`/reports/${r.id}/request-edits`, { comment }))
            setClosing(null)
            setNotice({
              tone: 'ok',
              text:
                r.status === 'closed'
                  ? `Edits requested. ${periodLabel(r.period)} is a draft again and its closing needs approving again.`
                  : `Edits requested on ${periodLabel(r.period)}. The request shows on the month until its closing is approved.`,
            })
          }}
        />
      )}
      {closing === 'reopen' && (
        <ReopenModal
          report={r}
          onClose={() => setClosing(null)}
          onSave={async (reason) => {
            setData(await api.post<ReportDetail>(`/reports/${r.id}/reopen`, { reason }))
            setClosing(null)
            setNotice({
              tone: 'ok',
              text: `${periodLabel(r.period)} reopened. It is a draft again: correct it, then approve its closing and submit it again.`,
            })
          }}
        />
      )}
    </>
  )

  return (
    <>
      <LayoutC
        r={r}
        busy={busy}
        notice={notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        highlight={highlight}
        sections={{ receipts: receiptsCard, payrollProof: payrollProofCard, earlier }}
        act={{
          ...act,
          addExpense: () => act.add('expense'),
          addPayroll: () => act.add('payroll'),
          importTransactions: () => setImporting(true),
          approve: () => setClosing('approve'),
          sendBack: () => setClosing('send-back'),
          requestEdits: () => setClosing('request-edits'),
          reopen: () => setClosing('reopen'),
          attachSigned: () => setSigning(true),
          submit: () => void submit(),
          downloadBundle: () => void downloadBundle(),
          recheck: () =>
            void run(() => api.post<ReportDetail>(`/reports/${r.id}/recheck`), 'Checks run again.'),
          deleteMonth: () => void deleteMonth(),
        }}
      />
      {modals}
    </>
  )
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The month-end closing: the company's own approval of the month (the CEO's, often given offline) before the
 * report goes to the funder. The bookkeeper records who approved it and when.
 */
function ClosingModal({
  report,
  onClose,
  onSave,
}: {
  report: ReportDetail
  onClose: () => void
  onSave: (body: ClosingInput) => Promise<void>
}) {
  const [form, setForm] = useState<ClosingInput>({
    approvedBy: report.engagement.authorizerName ?? '',
    approvedOn: today(),
    note: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(form)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Month-end closing for ${periodLabel(report.period)}`} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorNote message={error} />
        <p className="mb-4 text-sm text-soft">
          Record who approved this month for your company, and when, before it goes to{' '}
          {report.engagement.funder ?? 'the funder'}. Once approved, the ledger is locked until the
          closing is sent back.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Approved by" required>
            <input
              className={inputClass}
              value={form.approvedBy}
              onChange={(e) => setForm({ ...form, approvedBy: e.target.value })}
              maxLength={120}
              required
              data-testid="closing-by"
            />
          </Field>
          <Field label="Approved on" required>
            <input
              type="date"
              className={inputClass}
              value={form.approvedOn}
              max={today()}
              onChange={(e) => setForm({ ...form, approvedOn: e.target.value })}
              required
            />
          </Field>
        </div>
        <Field label="Note" hint="Optional" className="mt-4">
          <textarea
            className={inputClass}
            rows={2}
            maxLength={2000}
            value={form.note ?? ''}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="primary" disabled={busy} data-testid="closing-approve">
            Record as approved
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Reopening a submitted month makes it a draft again to correct it (a typo, say), with the reason on its page. Its
 * documents stay; it is closed and submitted again.
 */
function ReopenModal({
  report,
  onClose,
  onSave,
}: {
  report: ReportDetail
  onClose: () => void
  onSave: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(reason)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Reopen ${periodLabel(report.period)} to correct it`} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorNote message={error} />
        <p className="mb-4 text-sm text-soft">
          The month becomes a draft again so you can correct it. Its documents stay, and the signed
          copy you submitted is kept under Earlier submissions. Then approve its month-end closing
          again, attach the corrected signed copy and submit it again.
        </p>
        <Field label="Why it is reopened" required>
          <textarea
            className={inputClass}
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </Field>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="danger" disabled={busy || !reason.trim()}>
            Reopen
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Every time the submitted month was reopened, newest first: the submission it undid, the closing's approval, who
 * reopened it and why, and the signed copy as it was submitted. Every member reads it, auditors too.
 */
function EarlierSubmissions({ report }: { report: ReportDetail }) {
  return (
    <Card title="Earlier submissions" aside={<Chip tone="muted">{report.reopenings.length}</Chip>}>
      <p className="mb-3 text-sm text-soft">
        Each time this month was reopened to correct it, what had been submitted is kept here.
      </p>
      <div className="ad-tablewrap">
        <table className="ad-table" data-testid="earlier-submissions">
          <thead>
            <tr>
              <th>Submitted on</th>
              <th>Month-end closing approved</th>
              <th>Reopened</th>
              <th>Why</th>
              <th>Signed copy as submitted</th>
            </tr>
          </thead>
          <tbody>
            {report.reopenings.map((o) => (
              <tr key={o.id}>
                <td className="whitespace-nowrap">{shortDate(o.submittedAt)}</td>
                <td>
                  {o.approvedAt ? shortDate(o.approvedAt) : '—'}
                  {o.approvedByName && <span className="ad-table-sub">by {o.approvedByName}</span>}
                </td>
                <td>
                  {shortDate(o.reopenedAt)}
                  <span className="ad-table-sub">by {o.reopenedBy}</span>
                </td>
                <td>{o.reason}</td>
                <td>
                  {o.signedDocument ? (
                    <DocumentLink doc={o.signedDocument} />
                  ) : (
                    <span className="text-soft">not on file</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/**
 * Asking for edits, with a comment: on a draft it is recorded on the month, the status unchanged; on a month whose
 * closing is approved it sends the closing back, so the month is a draft again.
 */
function RequestEditsModal({
  report,
  onClose,
  onSave,
}: {
  report: ReportDetail
  onClose: () => void
  onSave: (comment: string) => Promise<void>
}) {
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(comment)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Request edits on ${periodLabel(report.period)}`} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorNote message={error} />
        <p className="mb-4 text-sm text-soft">
          {report.status === 'closed'
            ? 'The closing is sent back: the month becomes a draft again so it can be corrected, and its closing needs approving again.'
            : 'The month stays a draft. Your comment shows on it until its closing is approved.'}
        </p>
        <Field label="What needs editing" required>
          <textarea
            className={inputClass}
            rows={3}
            maxLength={500}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            required
          />
        </Field>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="navy" disabled={busy || !comment.trim()}>
            ✏️ Request edits
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** Sending the month-end closing back reopens the month as a draft, with the reason on its page. */
function SendBackModal({
  report,
  onClose,
  onSave,
}: {
  report: ReportDetail
  onClose: () => void
  onSave: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(reason)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Send back the closing of ${periodLabel(report.period)}`} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorNote message={error} />
        <p className="mb-4 text-sm text-soft">
          The month becomes a draft again so you can correct it, and its closing needs approving
          again.
        </p>
        <Field label="Why it was sent back" required>
          <textarea
            className={inputClass}
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </Field>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="danger" disabled={busy || !reason.trim()}>
            Send back
          </Button>
        </div>
      </form>
    </Modal>
  )
}
