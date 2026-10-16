import { Suspense, lazy, useEffect, useState } from 'react'
import {
  DOCUMENT_KIND_LABELS,
  PAYROLL_DOCUMENT_KINDS,
  PAYROLL_REPORT_LINES,
  REPORT_LINE_LABELS,
  type AttachedDocument,
  type DocumentDto,
  type DocumentPurpose,
  type PayrollDocumentKind,
  type PayrollLineSearch,
  type PayrollUploadResult,
  type ReportDetail,
  type StatementMark,
} from '@ad/types'
import { useApi } from '@/hooks/useApi'
import {
  PAYROLL_FOLDERS,
  filesFromZip,
  sortPayrollZip,
  type PayrollFolderKind,
} from '@/lib/zip-files'
import { HandCard } from '@/components/HandCard'
import './match-pairs.css'
import {
  decideRegister,
  decideStub,
  decideTimesheet,
  registerFor,
  stubFor,
  timesheetFor,
  type MatchDoc,
  type MatchItem,
} from '@/lib/payroll-match'
import { money, payPeriodWords, periodLabel, shortDate } from '@/lib/format'
import { DocumentLink } from '@/components/DocumentLink'
import {
  Button,
  Card,
  Stepper,
  Chip,
  Empty,
  ErrorNote,
  Field,
  Modal,
  Notice,
  inputClass,
} from '@/components/ui'

/** pdf.js is large: it loads when a statement is first shown, not with the month's page. */
const LazyViewer = lazy(() =>
  import('@/components/StatementViewer').then((m) => ({ default: m.StatementViewer }))
)
const StatementViewer = (props: React.ComponentProps<typeof LazyViewer>) => (
  <Suspense fallback={<p className="text-sm text-soft">Opening the statement…</p>}>
    <LazyViewer {...props} />
  </Suspense>
)

/** What the screen says when a statement has no text layer. */
export const SCANNED_WARNING =
  "This statement looks scanned, so its lines can't be searched. Download it from your bank as a PDF, or draw the box by hand."

/** What "Find the line" says about the month's statements it left out (it reads the newest first). */
export const notSearchedNote = (n: number) =>
  n === 1
    ? '1 older statement of this month was not searched.'
    : `${n} older statements of this month were not searched.`

/** A payroll expense line or a work-experience payment, as this card lists it. */
interface PayrollItem extends MatchItem {
  target: 'expense' | 'wex'
  id: string
  title: string
  sub: string
  /** The "Date" column, as the Payroll & Proof grid shows it: a staff line's date, a participant's pay period. */
  paid: string
  amount: number
  documents: AttachedDocument<DocumentPurpose>[]
}

/** The three proofs a payroll item needs, and the purpose each is attached as. */
type Slot = 'timesheet' | 'register' | 'stub'
const PURPOSE: Record<Slot, DocumentPurpose> = {
  timesheet: 'timesheet',
  register: 'register',
  stub: 'payment',
}
const KIND: Record<Slot, string> = {
  timesheet: 'timesheet',
  register: 'payroll-register',
  stub: 'paystub',
}
const keyOf = (i: { target: string; id: string }) => `${i.target}-${i.id}`

const kindLabel = (k: PayrollDocumentKind) => {
  const w = DOCUMENT_KIND_LABELS[k]
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** The item's bank statement line, if one is marked. */
const markedLine = (item: PayrollItem) =>
  item.documents.find(
    (d) => d.purpose === 'payment' && d.document.kind === 'bank-statement' && d.mark
  )

/**
 * The month's payroll proof: bank statements, payroll registers and pay stubs uploaded in bulk, and each payroll item
 * linked to the bank statement line it was paid on, with that line marked on the page. Pay stubs are personal: never
 * previewed, and opened by owners and auditors only.
 */
export function PayrollProof({
  report: r,
  onChange,
  onNotice,
}: {
  report: ReportDetail
  onChange: (report: ReportDetail) => void
  onNotice: (text: string) => void
}) {
  const STEPS = ['Upload', 'Match', 'Bank lines', 'Done'] as const
  // "Replace this month's payroll files": the earlier files, hidden from matching while the wizard runs and removed
  // only when it finishes. Leaving before then removes nothing.
  const [replacing, setReplacing] = useState<string[]>([])
  // The zip's files, held in the browser until Save: matching needs only their names. Nothing is sent before then.
  const [pending, setPending] = useState<{ tid: string; file: File; kind: PayrollFolderKind }[]>([])
  const kept = (ds: AttachedDocument<DocumentPurpose>[]) =>
    ds.filter((d) => !replacing.includes(d.document.id))
  // Every opening starts at Upload, fresh: nothing of an earlier, unsaved run is kept.
  const [step, setStep] = useState<(typeof STEPS)[number]>('Upload')
  const [finding, setFinding] = useState<PayrollItem | null>(null)
  const [viewing, setViewing] = useState<{
    item: PayrollItem
    doc: DocumentDto
    mark: StatementMark
  } | null>(null)

  const items: PayrollItem[] = [
    ...r.expenses
      .filter((e) => PAYROLL_REPORT_LINES.has(e.reportLine))
      .map((e) => ({
        target: 'expense' as const,
        kind: 'staff' as const,
        start: e.date,
        end: e.date,
        id: e.id,
        title: `${e.itemNumber} ${e.vendor}`,
        sub: REPORT_LINE_LABELS[e.reportLine],
        paid: shortDate(e.date),
        amount: e.totalCost,
        documents: kept(e.documents),
      })),
    ...r.wexPayments.map((w) => ({
      target: 'wex' as const,
      kind: 'participant' as const,
      start: w.payPeriodStart,
      end: w.payPeriodEnd,
      name: w.participantName,
      id: w.id,
      title: w.participantName,
      sub: w.participantNumber,
      paid: payPeriodWords(w.payPeriodStart, w.payPeriodEnd),
      amount: w.grossAmount,
      documents: kept(w.documents),
    })),
  ]
  const api = useApi()
  const docs: MatchDoc[] = [
    ...r.payrollDocuments
      .filter((d) => !replacing.includes(d.id))
      .map((d) => ({ id: d.id, kind: d.kind, fileName: d.fileName })),
    ...pending.map((p) => ({ id: p.tid, kind: p.kind, fileName: p.file.name })),
  ]
  const has = (item: PayrollItem, slot: Slot) =>
    item.documents.find(
      (d) => d.purpose === PURPOSE[slot] && (slot !== 'stub' || d.document.kind === 'paystub')
    )
  // What still needs a document: pre-filled when exactly one fits (⚡), the rest chosen here, in bulk or one by one.
  const suggest = (item: PayrollItem, slot: Slot) =>
    slot === 'timesheet'
      ? timesheetFor(item, docs)
      : slot === 'register'
        ? registerFor(item, docs)
        : stubFor(item, docs)
  // Why each slot was filled or left empty, for "How Auto-Match decided".
  const whyOf = (item: PayrollItem, slot: Slot) => {
    const attached = has(item, slot)
    if (attached) return { tone: 'ok', file: attached.document.fileName, text: 'Already attached.' }
    const chosen = picks[keyOf(item)]?.[slot]
    if (chosen) {
      const d = docs.find((x) => x.id === chosen)
      return { tone: 'ok', file: d?.fileName, text: 'Chosen by you.' }
    }
    if (chosen === '') return { tone: 'missing', file: undefined, text: 'Cleared by you.' }
    const d =
      slot === 'timesheet'
        ? decideTimesheet(item, docs)
        : slot === 'register'
          ? decideRegister(item, docs)
          : decideStub(item, docs)
    return {
      tone: d.match ? (d.match.sure ? 'ok' : 'guess') : 'missing',
      file: d.file,
      text: d.why,
    }
  }
  const [picks, setPicks] = useState<Record<string, Partial<Record<Slot, string>>>>({})
  const pick = (item: PayrollItem, slot: Slot) =>
    picks[keyOf(item)]?.[slot] ?? (has(item, slot) ? '' : (suggest(item, slot)?.id ?? ''))
  const setPick = (item: PayrollItem, slot: Slot, v: string) =>
    setPicks((p) => ({ ...p, [keyOf(item)]: { ...p[keyOf(item)], [slot]: v } }))
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<{ timesheet: string; register: string }>({
    timesheet: '',
    register: '',
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const slotsOf = (item: PayrollItem): Slot[] =>
    item.kind === 'participant' ? ['timesheet', 'register', 'stub'] : ['timesheet', 'register']
  const isProved = (i: PayrollItem) =>
    slotsOf(i).every((slot) => has(i, slot)) && (i.kind === 'participant' || !!markedLine(i))
  const openItems = items.filter((i) => !isProved(i))
  const staffItems = items.filter((i) => i.kind === 'staff')
  const unmarkedStaff = staffItems.filter((i) => !markedLine(i)).length
  const doneItems = items.filter(isProved)
  const proved = items.filter(
    (i) => slotsOf(i).every((slot) => has(i, slot)) && (i.kind === 'participant' || markedLine(i))
  ).length
  const q = search.trim().toLowerCase()
  const shown = q
    ? openItems.filter((i) => `${i.title} ${i.sub} ${i.amount}`.toLowerCase().includes(q))
    : openItems
  const allShown = shown.length > 0 && shown.every((i) => chosen.has(keyOf(i)))
  const toSave = items.flatMap((item) =>
    slotsOf(item)
      .filter((slot) => !has(item, slot) && pick(item, slot))
      .map((slot) => ({ item, slot, documentId: pick(item, slot) }))
  )
  const [progress, setProgress] = useState<string | null>(null)
  const dirty = pending.length > 0 || toSave.length > 0 || replacing.length > 0
  /**
   * Save, all at once: the zip's files go up (20 at a time), every match is attached, and the replaced files go. Until
   * this runs the month is as it was. If it stops part way, what went up stays, and the matches can be saved again.
   */
  const saveAll = async () => {
    setSaving(true)
    setSaveError(null)
    const ids = new Map<string, string>()
    try {
      let last: ReportDetail | null = null
      for (let at = 0; at < pending.length; at += 20) {
        const batch = pending.slice(at, at + 20)
        setProgress(`Uploading files ${at + 1}–${at + batch.length} of ${pending.length}…`)
        const form = new FormData()
        for (const p of batch) {
          form.append('files', p.file)
          form.append('kinds', p.kind)
        }
        const res = await api.upload<PayrollUploadResult>(
          `/reports/${r.id}/payroll-documents`,
          form
        )
        batch.forEach((p, i) => ids.set(p.tid, res.documentIds[i]!))
        last = res.report
      }
      for (const [i, t] of toSave.entries()) {
        setProgress(`Saving match ${i + 1} of ${toSave.length}…`)
        last = await api.post<ReportDetail>(
          `/${t.item.target === 'wex' ? 'wex' : 'expenses'}/${t.item.id}/documents`,
          { documentId: ids.get(t.documentId) ?? t.documentId, purpose: PURPOSE[t.slot] }
        )
      }
      if (replacing.length) {
        setProgress('Removing the earlier files…')
        last = await api.post<ReportDetail>(`/reports/${r.id}/payroll-documents/replace`, {
          documentIds: replacing,
        })
      }
      if (last) onChange(last)
      onNotice(
        [
          pending.length && `Uploaded ${pending.length} ${pending.length === 1 ? 'file' : 'files'}`,
          toSave.length && `saved ${toSave.length} ${toSave.length === 1 ? 'match' : 'matches'}`,
          replacing.length &&
            `removed ${replacing.length} earlier ${replacing.length === 1 ? 'file' : 'files'}`,
        ]
          .filter(Boolean)
          .join(', ') + '.'
      )
      setPending([])
      setReplacing([])
      setPicks({})
      setChosen(new Set())
      return true
    } catch (e) {
      // What went up stays up: point the choices at the stored files so Save can be pressed again without uploading twice.
      if (ids.size) {
        setPending((p) => p.filter((x) => !ids.has(x.tid)))
        setPicks((ps) =>
          Object.fromEntries(
            Object.entries(ps).map(([k, v]) => [
              k,
              Object.fromEntries(Object.entries(v).map(([slot, id]) => [slot, ids.get(id!) ?? id])),
            ])
          )
        )
      }
      setSaveError((e as Error).message)
      return false
    } finally {
      setSaving(false)
      setProgress(null)
    }
  }
  const docSelect = (item: PayrollItem, slot: Slot) => {
    const attached = has(item, slot)
    if (attached) {
      const word =
        slot === 'timesheet' ? 'Timesheet' : slot === 'register' ? 'Register' : 'Pay stub'
      return (
        <Chip tone="ok" fill title={attached.document.fileName}>
          {attached.document.sensitivity === 'personal' && !r.can.readPersonal ? (
            <>✓ {word}</>
          ) : (
            <DocumentLink doc={attached.document}>✓ {word}</DocumentLink>
          )}
        </Chip>
      )
    }
    const options = docs.filter((d) => d.kind === KIND[slot])
    const value = pick(item, slot)
    const guess = suggest(item, slot)
    const auto = !picks[keyOf(item)]?.[slot] && value && guess && value === guess.id
    if (!r.can.edit) return <Chip tone="warn">missing</Chip>
    // The cell says how sure it is: green when matched (by Auto-Match or by hand), amber for a guess, red when missing.
    const state = !value ? 'missing' : auto && !guess.sure ? 'guess' : 'ok'
    return (
      <>
        <select
          className={`${inputClass} ad-match-${state}`}
          aria-label={`${slot} for ${item.title}`}
          value={value}
          onChange={(e) => setPick(item, slot, e.target.value)}
        >
          <option value="">{options.length ? 'Choose…' : 'None uploaded'}</option>
          {options.map((d) => (
            <option key={d.id} value={d.id}>
              {d.fileName}
            </option>
          ))}
        </select>
        {state === 'missing' ? (
          <small className="ad-match-note-missing">✕ Missing</small>
        ) : state === 'guess' ? (
          <small className="ad-match-note-guess">⚠️ ⚡ Best guess: check the dates</small>
        ) : (
          <small className="ad-match-note-ok">✓ {auto ? '⚡ Auto-matched' : 'Chosen'}</small>
        )}
      </>
    )
  }

  return (
    <Card
      className="mt-4"
      title="Payroll proof"
      aside={
        <>
          <span className="text-xs text-soft">
            {proved} of {items.length} payroll item{items.length === 1 ? '' : 's'} fully proved
          </span>
        </>
      }
    >
      <Stepper steps={STEPS} current={step} />
      {(pending.length > 0 || replacing.length > 0) && step !== 'Done' && (
        <p className="ad-replacing" role="status">
          Nothing is saved until you press Save
          {replacing.length
            ? `, which also removes the ${replacing.length} earlier payroll ${replacing.length === 1 ? 'file' : 'files'}`
            : ''}
          . Close now and the month stays as it was.
        </p>
      )}
      {step === 'Bank lines' && <ErrorNote message={saveError} />}
      {step === 'Upload' && (
        <div className="grid gap-4">
          <HandCard
            title="How payroll proof works"
            icon="🧾"
            lead="Every payroll item needs a timesheet, a payroll register and evidence of payment."
          >
            <ol className="ad-hand-steps">
              <li>
                Upload the month&apos;s payroll zip, in the sample&apos;s four folders. Its files
                join what&apos;s already here.
              </li>
              <li>Auto-Match pairs each file with its item by pay period and name.</li>
              <li>Check the matches and save.</li>
            </ol>
            <p>Evidence of payment: a pay stub for participants, the bank line for staff.</p>
            <p className="ad-hand-address">
              <span className="ad-hand-address-label">Already in {periodLabel(r.period)}</span>
              <span>
                {PAYROLL_DOCUMENT_KINDS.map((k) => {
                  const n = r.payrollDocuments.filter((d) => d.kind === k).length
                  return `${n} ${kindLabel(k).toLowerCase()}${n === 1 ? '' : 's'}`
                }).join(' · ')}
              </span>
              <a href="/samples/payroll-sample.zip" download>
                Download a sample (zip)
              </a>
            </p>
          </HandCard>
          {r.can.edit ? (
            <UploadPanel
              existing={r.payrollDocuments.length}
              onReady={(files, replace) => {
                setPending(files.map((f, i) => ({ tid: `new-${i}`, file: f.file, kind: f.kind })))
                setReplacing(replace ? r.payrollDocuments.map((d) => d.id) : [])
                setPicks({})
                setStep('Match')
              }}
              onSkip={r.payrollDocuments.length ? () => setStep('Match') : undefined}
            />
          ) : (
            <div className="ad-actions justify-end">
              <Button kind="primary" onClick={() => setStep('Match')}>
                Next: match
              </Button>
            </div>
          )}
        </div>
      )}

      {step === 'Match' && items.length === 0 && (
        <Empty>No payroll lines or work-experience payments this month.</Empty>
      )}
      {step === 'Match' && items.length > 0 && (
        <>
          {openItems.length === 0 ? (
            <Empty>Auto-Match proved every payroll item this month.</Empty>
          ) : (
            <section className="mx-work" aria-label="To match">
              <h3 className="mx-work-title">
                To match <span className="mx-count">{openItems.length}</span>
              </h3>
              {r.can.edit && (
                <div className="ad-bulkbar">
                  <label className="ad-search">
                    <svg
                      className="ad-search-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <circle cx="10.5" cy="10.5" r="6.5" />
                      <path d="M15.5 15.5 21 21" />
                    </svg>
                    <input
                      type="search"
                      placeholder="Search name, item or amount"
                      aria-label="Search the payroll items"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={allShown}
                      onChange={(e) => {
                        const next = new Set(chosen)
                        for (const i of shown)
                          if (e.target.checked) next.add(keyOf(i))
                          else next.delete(keyOf(i))
                        setChosen(next)
                      }}
                    />
                    {q ? `Select all ${shown.length} found` : 'Select all'}
                  </label>
                  {(['timesheet', 'register'] as const).map((slot) => (
                    <select
                      key={slot}
                      className={inputClass}
                      aria-label={`${slot} for the selected items`}
                      value={bulk[slot]}
                      onChange={(e) => setBulk({ ...bulk, [slot]: e.target.value })}
                    >
                      <option value="">{slot === 'timesheet' ? 'Timesheet…' : 'Register…'}</option>
                      {docs
                        .filter((d) => d.kind === KIND[slot])
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.fileName}
                          </option>
                        ))}
                    </select>
                  ))}
                  <Button
                    kind="navy"
                    size="sm"
                    disabled={!chosen.size || (!bulk.timesheet && !bulk.register)}
                    onClick={() => {
                      const next = { ...picks }
                      for (const i of items)
                        if (chosen.has(keyOf(i)))
                          next[keyOf(i)] = {
                            ...next[keyOf(i)],
                            ...(bulk.timesheet && !has(i, 'timesheet')
                              ? { timesheet: bulk.timesheet }
                              : {}),
                            ...(bulk.register && !has(i, 'register')
                              ? { register: bulk.register }
                              : {}),
                          }
                      setPicks(next)
                      setChosen(new Set())
                    }}
                  >
                    Set for selected
                  </Button>
                </div>
              )}
              <div className="ad-tablewrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      {r.can.edit && <th></th>}
                      <th>Vendor/Participant Paid</th>
                      <th>Date</th>
                      <th className="ad-num">Amount</th>
                      <th>Timesheet</th>
                      <th>Payroll register</th>
                      <th>Evidence of payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={7} className="text-soft">
                          No payroll item matches &ldquo;{search}&rdquo;.
                        </td>
                      </tr>
                    )}
                    {shown.map((item) => {
                      const line = markedLine(item)
                      return (
                        <tr key={keyOf(item)} data-testid={`payroll-${item.id}`}>
                          {r.can.edit && (
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select ${item.title}`}
                                checked={chosen.has(keyOf(item))}
                                onChange={(e) => {
                                  const next = new Set(chosen)
                                  if (e.target.checked) next.add(keyOf(item))
                                  else next.delete(keyOf(item))
                                  setChosen(next)
                                }}
                              />
                            </td>
                          )}
                          <td>
                            <span className="font-semibold">{item.title}</span>
                            <span className="ad-table-sub">{item.sub}</span>
                          </td>
                          <td className="whitespace-nowrap">{item.paid}</td>
                          <td className="ad-num font-semibold">{money(item.amount)}</td>
                          <td className="ad-matchcell">{docSelect(item, 'timesheet')}</td>
                          <td className="ad-matchcell">{docSelect(item, 'register')}</td>
                          <td className="ad-matchcell">
                            {item.kind === 'participant' ? (
                              docSelect(item, 'stub')
                            ) : line?.mark ? (
                              <>
                                <Chip tone="ok" fill title={line.document.fileName}>
                                  ✓ bank line, page {line.mark.page}
                                </Chip>{' '}
                                <Button
                                  size="sm"
                                  kind="ghost"
                                  onClick={() =>
                                    setViewing({ item, doc: line.document, mark: line.mark! })
                                  }
                                >
                                  show
                                </Button>
                              </>
                            ) : r.can.edit ? (
                              <Button
                                size="sm"
                                kind="navy"
                                onClick={() => setFinding(item)}
                                data-testid={`find-line-${item.id}`}
                              >
                                Find the bank line
                              </Button>
                            ) : (
                              <Chip tone="warn">missing</Chip>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <ErrorNote message={saveError} />
          {openItems.length > 0 && (
            <section className="mx-panel" aria-label="How Auto-Match decided">
              <details>
                <summary>
                  <span className="mx-chevron" aria-hidden="true">
                    ▸
                  </span>
                  <span className="mx-panel-title">How Auto-Match decided</span>
                  <span className="text-sm text-soft">
                    Why each file was matched, or why nothing was.
                  </span>
                  <span className="mx-toggle" aria-hidden="true">
                    <span className="mx-toggle-show">Show</span>
                    <span className="mx-toggle-hide">Hide</span>
                  </span>
                </summary>
                <div className="mx-why-note">
                  <b>Auto-Match reads file names, not the files.</b>
                  <span>
                    A match says which file is the item&apos;s proof, from the dates (and, on a pay
                    stub, the person&apos;s name) in its file name. Only a staff payment&apos;s bank
                    line is found and highlighted inside a document, in the next step.
                  </span>
                </div>
                <div className="mx-why-list">
                  {openItems.map((item) => (
                    <div key={keyOf(item)} className="mx-why">
                      <div className="mx-why-head">
                        <b>{item.title}</b>
                        <span className="text-soft">
                          {item.paid} · {money(item.amount)}
                        </span>
                      </div>
                      <table className="mx-why-table">
                        <tbody>
                          {[
                            ...slotsOf(item).map((slot) => ({
                              label:
                                slot === 'timesheet'
                                  ? 'Timesheet'
                                  : slot === 'register'
                                    ? 'Payroll register'
                                    : 'Pay stub',
                              ...whyOf(item, slot),
                            })),
                            ...(item.kind === 'staff'
                              ? [
                                  {
                                    label: 'Bank line',
                                    tone: markedLine(item) ? 'ok' : 'next',
                                    file: markedLine(item)?.document.fileName,
                                    text: markedLine(item)
                                      ? 'Marked on the bank statement.'
                                      : 'Found and marked on the bank statement in Bank lines.',
                                  },
                                ]
                              : []),
                          ].map((row) => (
                            <tr key={row.label} className={`mx-why-${row.tone}`}>
                              <th scope="row">{row.label}</th>
                              <td className="mx-why-result">
                                {row.tone === 'ok'
                                  ? '✓ Matched'
                                  : row.tone === 'guess'
                                    ? '⚠️ Best guess'
                                    : row.tone === 'next'
                                      ? '→ Next step'
                                      : '✕ Not matched'}
                              </td>
                              <td className="mx-why-file" title={row.file}>
                                {row.file ?? '—'}
                              </td>
                              <td>{row.text}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </details>
            </section>
          )}
          {doneItems.length > 0 && (
            <section className="mx-panel" aria-label="Fully proved">
              <details>
                <summary>
                  <span className="mx-chevron" aria-hidden="true">
                    ▸
                  </span>
                  <span className="mx-panel-title">Review the {doneItems.length} fully proved</span>
                  <span className="text-sm text-soft">Each item with its three proofs.</span>
                  <span className="mx-toggle" aria-hidden="true">
                    <span className="mx-toggle-show">Show</span>
                    <span className="mx-toggle-hide">Hide</span>
                  </span>
                </summary>
                <ul className="mx-list">
                  {doneItems.map((item) => (
                    <li key={keyOf(item)} className="mx-row">
                      <span>
                        <b>{item.title}</b> · {money(item.amount)}
                        <span className="ad-table-sub">{item.sub}</span>
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {docSelect(item, 'timesheet')}
                        {docSelect(item, 'register')}
                        {item.kind === 'participant' ? (
                          docSelect(item, 'stub')
                        ) : (
                          <Chip tone="ok" fill>
                            ✓ bank line
                          </Chip>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          )}
          <div className="ad-actions justify-between">
            <Button kind="ghost" onClick={() => setStep('Upload')}>
              Back: upload
            </Button>
            <Button
              kind="primary"
              onClick={async () => {
                if (dirty && !(await saveAll())) return
                setStep(staffItems.length ? 'Bank lines' : 'Done')
              }}
              disabled={saving}
            >
              {saving ? (progress ?? 'Saving…') : dirty ? 'Save and continue' : 'Next'}
            </Button>
          </div>
        </>
      )}

      {step === 'Bank lines' && (
        <div className="grid gap-4">
          <section className="mx-work" aria-label="Bank lines">
            <h3 className="mx-work-title">
              Bank lines for staff pay{' '}
              {unmarkedStaff > 0 && <span className="mx-count">{unmarkedStaff}</span>}
            </h3>
            <p className="text-sm text-soft">
              Staff pay is proved by its line on the bank statement: find it once per item and it is
              marked on the page.
            </p>
            <ul className="mx-list">
              {staffItems.map((item) => {
                const line = markedLine(item)
                return (
                  <li key={keyOf(item)} className="mx-row">
                    <span>
                      <b>{item.title}</b> · {money(item.amount)}
                      <span className="ad-table-sub">{item.sub}</span>
                    </span>
                    {line?.mark ? (
                      <span>
                        <Chip tone="ok" fill title={line.document.fileName}>
                          ✓ line marked, page {line.mark.page}
                        </Chip>{' '}
                        <Button
                          size="sm"
                          kind="ghost"
                          onClick={() => setViewing({ item, doc: line.document, mark: line.mark! })}
                        >
                          show
                        </Button>
                      </span>
                    ) : r.can.edit ? (
                      <Button size="sm" kind="navy" onClick={() => setFinding(item)}>
                        Find the bank line
                      </Button>
                    ) : (
                      <Chip tone="warn">missing</Chip>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
          <div className="ad-actions justify-between">
            <Button kind="ghost" onClick={() => setStep('Match')}>
              Back: match
            </Button>
            <Button kind="primary" onClick={() => setStep('Done')}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 'Done' && (
        <div className="grid gap-4">
          <div className="ad-done">
            <span className="ad-done-check" aria-hidden="true">
              ✓
            </span>
            <h3>
              {proved} of {items.length} payroll {items.length === 1 ? 'item' : 'items'} fully
              proved
            </h3>
            <p>A timesheet, the payroll register and evidence of payment for each.</p>
          </div>
          <div className="ad-done-tiles">
            <div className="ad-tile ad-tile-ok">
              <span className="ad-tile-label">Fully proved</span>
              <span className="ad-tile-value">{proved}</span>
            </div>
            <div className={`ad-tile ${items.length - proved ? 'ad-tile-warn' : 'ad-tile-ok'}`}>
              <span className="ad-tile-label">Still missing proof</span>
              <span className="ad-tile-value">{items.length - proved}</span>
            </div>
            <div className="ad-tile">
              <span className="ad-tile-label">Documents uploaded</span>
              <span className="ad-tile-value">{r.payrollDocuments.length}</span>
            </div>
          </div>
          <HandCard
            title="What to do next"
            icon="📎"
            lead={
              items.length - proved
                ? 'Go back to Match for the items still missing a document.'
                : 'Payroll proof is complete for this month.'
            }
          >
            <p>Each item&apos;s proof shows on its row in Payroll &amp; Proof.</p>
          </HandCard>
          <div className="ad-actions justify-start">
            <Button kind="ghost" onClick={() => setStep('Match')}>
              Back: match
            </Button>
          </div>
        </div>
      )}

      {finding && (
        <FindLineModal
          item={finding}
          onClose={() => setFinding(null)}
          onLinked={(report) => {
            setFinding(null)
            onChange(report)
            onNotice(`Marked the bank statement line for ${finding.title}.`)
          }}
        />
      )}
      {viewing && (
        <Modal
          title={`${viewing.item.title}: bank statement line`}
          onClose={() => setViewing(null)}
          wide
        >
          <p className="mb-3 text-sm text-soft">
            {viewing.mark.text ? `“${viewing.mark.text}” · ` : ''}page {viewing.mark.page} of{' '}
            {viewing.doc.fileName}
          </p>
          <StatementViewer doc={viewing.doc} mark={viewing.mark} />
        </Modal>
      )}
    </Card>
  )
}

/** What one payroll zip may hold: the zip is opened in the browser, and its files go up 20 at a time. */
const ZIP_MAX_BYTES = 250 * 1024 * 1024
const ZIP_MAX_FILES = 200
/** The server's limit for one file (MAX_UPLOAD_BYTES in the API). */
const FILE_MAX_BYTES = 25 * 1024 * 1024
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`

/**
 * Step 1: one zip with the four folders (Timesheets, Payroll registers, Pay stubs, Bank statements), opened in the
 * browser. Each folder sets its files' type; a zip laid out any other way is refused, with every problem at once.
 * Nothing is sent here: the files go up, 20 at a time, when the person saves at the end of matching.
 */
function UploadPanel({
  existing,
  onReady,
  onSkip,
}: {
  /** How many payroll files the month already has: "Replace them" is offered when there are any. */
  existing: number
  /** The zip checked and sorted: on to matching. Nothing has been sent. */
  onReady: (files: { file: File; kind: PayrollFolderKind }[], replace: boolean) => void
  /** Already uploaded this month: go on to matching without uploading more. */
  onSkip?: () => void
}) {
  const [zipName, setZipName] = useState<string | null>(null)
  const [files, setFiles] = useState<{ file: File; kind: PayrollFolderKind; folder: string }[]>([])
  const [problems, setProblems] = useState<string[]>([])
  // Too big to take: the zip, the number of files, or one file over the server's limit. Said as it is, not as a layout problem.
  const [tooBig, setTooBig] = useState<string | null>(null)
  const [replace, setReplace] = useState(false)
  const choose = async (zip: File | undefined) => {
    setFiles([])
    setProblems([])
    setTooBig(null)
    setZipName(zip?.name ?? null)
    if (!zip) return
    if (zip.size > ZIP_MAX_BYTES) {
      setTooBig(
        `This zip is ${mb(zip.size)}; the limit is ${mb(ZIP_MAX_BYTES)}. Split the month into two zips with the same four folders.`
      )
      return
    }
    if (!/\.zip$/i.test(zip.name)) {
      setProblems(['Choose a .zip file with the four folders.'])
      return
    }
    try {
      const opened = await filesFromZip(zip)
      const sorted = sortPayrollZip(opened.files, opened.skipped)
      const big = sorted.files.filter((f) => f.file.size > FILE_MAX_BYTES)
      if (sorted.files.length > ZIP_MAX_FILES)
        setTooBig(
          `This zip has ${sorted.files.length} files; the limit is ${ZIP_MAX_FILES}. Split it into two zips with the same four folders.`
        )
      else if (big.length)
        setTooBig(
          `${big.length === 1 ? '1 file is' : `${big.length} files are`} over ${mb(FILE_MAX_BYTES)}: ${big
            .slice(0, 3)
            .map((f) => f.file.name)
            .join(', ')}${big.length > 3 ? ', …' : ''}.`
        )
      setFiles(sorted.files)
      setProblems(sorted.problems)
    } catch (e) {
      setProblems([(e as Error).message])
    }
  }

  return (
    <div className="grid gap-3">
      {tooBig && (
        <p className="ad-field-error-sum" role="status">
          {tooBig}
        </p>
      )}
      {!tooBig && problems.length > 0 && (
        <p className="ad-field-error-sum" role="status">
          Choose a .zip file with the four folders, matching the structure and folders of the sample
          (zip) above.
        </p>
      )}
      <Field
        label="Payroll zip"
        required
        hint={`One zip with four folders: Timesheets, Payroll registers, Pay stubs and Bank statements, as in the sample above. Up to ${mb(ZIP_MAX_BYTES)} and ${ZIP_MAX_FILES} files; each file up to ${mb(FILE_MAX_BYTES)}.`}
      >
        <input
          type="file"
          accept=".zip,application/zip"
          className="block w-full text-sm"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </Field>
      {zipName && files.length > 0 && (
        <>
          <div className="ad-zip-head">
            <b>Found in uploaded {zipName}</b>
            <span className="text-sm text-soft">
              {problems.length
                ? 'Fix the zip, then choose it again.'
                : `${files.length} ${files.length === 1 ? 'file' : 'files'} ready to upload, sorted by folder.`}
            </span>
          </div>
          <div className="ad-zip-summary" aria-label="What the zip holds">
            {PAYROLL_FOLDERS.map(([name]) => {
              const n = files.filter((f) => f.folder === name).length
              return (
                <div key={name} className={`ad-tile ${n ? 'ad-tile-ok' : 'ad-tile-warn'}`}>
                  <span className="ad-tile-label">{name}</span>
                  <span className="ad-tile-value">{n}</span>
                  <span className="ad-tile-note">{n === 1 ? 'file' : 'files'}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
      {existing > 0 && (
        <label className="ad-replace-opt">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          <span>
            <b>
              Replace this month&apos;s {existing} payroll {existing === 1 ? 'file' : 'files'}
            </b>
            <small>
              Matching uses only this zip. The earlier files are removed, with their matches, when
              you save at the end; nothing changes if you close before then.
            </small>
          </span>
        </label>
      )}
      <p className="text-xs text-soft">
        Auto-Match works best on PDFs you get directly from your financial institution vs scans or
        photos.
      </p>
      <div className="ad-actions justify-end">
        {onSkip && (
          <Button kind="ghost" onClick={onSkip}>
            Skip: Re-attempt a match of existing uploaded files
          </Button>
        )}
        <Button
          kind="primary"
          onClick={() => onReady(files, replace)}
          disabled={!files.length || problems.length > 0 || !!tooBig}
        >
          Next: match
        </Button>
      </div>
    </div>
  )
}

/**
 * "Find the line": the month's bank statements searched for the item's amount. The person picks the line (or, when
 * nothing was found, draws the box by hand on the page) and confirms; the link is the item's evidence of payment.
 */
function FindLineModal({
  item,
  onClose,
  onLinked,
}: {
  item: PayrollItem
  onClose: () => void
  onLinked: (report: ReportDetail) => void
}) {
  const api = useApi()
  const [search, setSearch] = useState<PayrollLineSearch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<{ documentId: string; mark: StatementMark } | null>(null)
  const [drawOn, setDrawOn] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let done = false
    api
      .get<PayrollLineSearch>(`/payroll/${item.target}/${item.id}/lines`)
      .then((s) => {
        if (done) return
        setSearch(s)
        const first = s.statements.find((x) => x.lines.length)
        if (first) setChosen({ documentId: first.document.id, mark: first.lines[0]! })
      })
      .catch((e: Error) => !done && setError(e.message))
    return () => {
      done = true
    }
  }, [api, item.id, item.target])

  const link = async () => {
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      onLinked(await api.put<ReportDetail>(`/payroll/${item.target}/${item.id}/statement`, chosen))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const statements = search?.statements ?? []
  const shown = statements.find((s) => s.document.id === (drawOn ?? chosen?.documentId))

  return (
    <Modal title={`${item.title}: find the bank statement line`} onClose={onClose} wide>
      <ErrorNote message={error} />
      {!search && !error && <Empty>Searching this month's bank statements…</Empty>}
      {search && statements.length === 0 && (
        <Empty>Upload this month's bank statement first, then find the line.</Empty>
      )}
      {search && statements.length > 0 && (
        <p className="mb-3 text-sm text-soft">
          Lines showing {money(search.amount)} on this month's bank statements. Pick the one that
          pays this item, or draw the box by hand.
        </p>
      )}
      {!!search?.notSearched && (
        <p className="mb-3 text-sm text-soft">{notSearchedNote(search.notSearched)}</p>
      )}
      {statements.map((s) => (
        <section key={s.document.id} className="mb-4">
          <h3 className="ad-group-title">{s.document.fileName}</h3>
          {s.scanned && <Notice tone="warn">{SCANNED_WARNING}</Notice>}
          {!s.scanned && s.lines.length === 0 && (
            <p className="text-sm text-soft">
              No line on this statement shows {money(search!.amount)}.
            </p>
          )}
          {s.lines.length > 0 && (
            <ul className="grid gap-1">
              {s.lines.map((l, i) => {
                const on =
                  !drawOn &&
                  chosen?.documentId === s.document.id &&
                  JSON.stringify(chosen.mark) === JSON.stringify(l)
                return (
                  <li key={i}>
                    <label className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name="line"
                        checked={on}
                        onChange={() => {
                          setDrawOn(null)
                          setChosen({ documentId: s.document.id, mark: l })
                        }}
                      />
                      <span>
                        <span className="text-soft">Page {l.page} · </span>
                        <span className="ad-mono">{l.text}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {s.document.contentType === 'application/pdf' && drawOn !== s.document.id && (
            <Button
              size="sm"
              kind="ghost"
              className="mt-1"
              onClick={() => {
                setDrawOn(s.document.id)
                setChosen(null)
              }}
            >
              Draw the box by hand
            </Button>
          )}
        </section>
      ))}
      {shown && shown.document.contentType === 'application/pdf' && (
        <>
          {drawOn && (
            <p className="mb-2 text-sm font-semibold">
              Drag a box around the line that pays this item.
            </p>
          )}
          <StatementViewer
            doc={shown.document}
            mark={drawOn ? null : chosen?.mark}
            onDraw={drawOn ? (mark) => setChosen({ documentId: drawOn, mark }) : undefined}
          />
        </>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" onClick={link} disabled={!chosen || busy} data-testid="link-line">
          {drawOn ? 'Link the box I drew' : 'Link this line'}
        </Button>
      </div>
    </Modal>
  )
}
