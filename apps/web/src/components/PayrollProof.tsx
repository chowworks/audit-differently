import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import {
  PAYROLL_PERSONAL_KINDS,
  DOCUMENT_KIND_LABELS,
  PAYROLL_DOCUMENT_KINDS,
  isPayrollLine,
  PAYROLL_SLOT_KIND,
  REPORT_LINE_LABELS,
  type AttachedDocument,
  type DocumentDto,
  type DocumentPurpose,
  type PayrollCandidate,
  type PayrollDocumentKind,
  type PayrollLineSearch,
  type PayrollMatchProgress,
  type PayrollMatchRunDto,
  type PayrollSlot,
  type ReportDetail,
  type StatementMark,
} from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import {
  PAYROLL_FOLDERS,
  filesFromZip,
  sortPayrollZip,
  type PayrollFolderKind,
} from '@/lib/zip-files'
import { HandCard } from '@/components/HandCard'
import './match-pairs.css'
import { money, payPeriodWords, periodLabel, shortDate } from '@/lib/format'
import { DocumentLink } from '@/components/DocumentLink'
import {
  MatchFooter,
  ProofFoot,
  ProvedCount,
  LineCapNotes,
  RemainingSection,
  MatchedBy,
  UnsavedNote,
  WhyPanel,
} from '@/components/payroll-match/MatchParts'
import {
  AiReadBox,
  AiReadingNote,
  useAiAfterUpload,
  usePayrollAi,
} from '@/components/payroll-match/AiReadBox'
import { SLOT_LABEL, slotWhy } from '@/components/payroll-match/why'
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
interface PayrollItem {
  target: 'expense' | 'wex'
  kind: 'staff' | 'participant'
  id: string
  title: string
  sub: string
  /** The "Date" column, as the Payroll & Proof grid shows it: a staff line's date, a participant's pay period. */
  paid: string
  amount: number
  documents: AttachedDocument<DocumentPurpose>[]
}

/** The proofs a payroll item needs, and the purpose each is attached as. */
const PURPOSE: Record<PayrollSlot, DocumentPurpose> = {
  timesheet: 'timesheet',
  register: 'register',
  stub: 'payment',
  bank: 'payment',
}
const keyOf = (i: { target: string; id: string }) => `${i.target}-${i.id}`
const slotsOf = (item: PayrollItem): PayrollSlot[] =>
  item.kind === 'participant'
    ? ['timesheet', 'register', 'stub']
    : ['timesheet', 'register', 'bank']

const kindLabel = (k: PayrollDocumentKind) => {
  const w = DOCUMENT_KIND_LABELS[k]
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** The item's bank statement line, if one is marked. */
const markedLine = (item: PayrollItem) =>
  item.documents.find(
    (d) => d.purpose === 'payment' && d.document.kind === 'bank-statement' && d.mark
  )

/** Files go up to the run 20 at a time, the server's limit for one request. */
const BATCH = 20

/**
 * The month's payroll proof. The zip's files are staged on the server and read there, line by line; Auto-Match finds
 * the line in each file where the item's name and pay (or its pay period) appear, and Show highlights it. Nothing in
 * the month changes until Save; closing the wizard discards the staged files. Pay stubs are personal but shown like
 * the other payroll files (owner's decision, 2026-10-16).
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
  const STEPS = ['Upload', 'Match', 'Unmatched payments', 'Done'] as const
  // An opening picks up the person's unsaved run of the month (the job keeps reading while the wizard is closed);
  // without one it starts at Upload.
  const [step, setStep] = useState<(typeof STEPS)[number]>('Upload')
  const [run, setRun] = useState<PayrollMatchRunDto | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  // Reading stopped being followed: the run is gone, expired or no longer editable, or the server kept failing.
  const [pollError, setPollError] = useState<string | null>(null)
  const [finding, setFinding] = useState<PayrollItem | null>(null)
  // An item's own copy of a proof, drawn on the server with only that item's highlights.
  const [viewing, setViewing] = useState<{
    title: string
    doc: Pick<DocumentDto, 'id' | 'sensitivity'> & { kind?: string }
    fileName: string
    src: string
    page: number
    words: string[]
  } | null>(null)
  const api = useApi()
  // The API client through a ref: its identity changes with Clerk's user object, and fetching again would log another
  // open of the run.
  const apiRef = useRef(api)
  apiRef.current = api
  // Reading on the server: how many of the run's files are done, polled until all are.
  const [progress, setProgress] = useState<PayrollMatchProgress | null>(null)
  const reportId = r.id
  const canEdit = r.can.edit
  useEffect(() => {
    if (!canEdit) return
    let gone = false
    void apiRef.current
      .get<PayrollMatchRunDto | null>(`/reports/${reportId}/payroll-match`)
      .then((open) => {
        if (gone || !open) return
        setRun(open)
        setStep('Match')
      })
      .catch((e: Error) => {
        if (!gone) setRunError(e.message)
      })
    return () => {
      gone = true
    }
  }, [reportId, canEdit])
  const runId = run?.id
  /** "Read the files with AI", ticked on the Upload step: unticked each time the wizard opens (#22). */
  const [withAi, setWithAi] = useState(false)
  const payrollAi = usePayrollAi()
  const waiting =
    !pollError && !!run?.files.some((f) => f.status === 'waiting' || f.status === 'reading')
  // Once the server has read the files, AI reads them when ticked, then the match is shown.
  const ai = useAiAfterUpload({
    run,
    ready: !!run && !waiting && !pollError,
    on: withAi && r.can.edit,
    read: (id, fileIds) =>
      api.post<PayrollMatchRunDto>(`/payroll-match/${id}/ai-read`, { fileIds }),
    onRun: setRun,
  })
  const atAi = step === 'Match' && !!run && !waiting && !pollError && ai.reading
  // Before the first poll, the run's own files say how far reading is.
  const shownProgress = progress ?? {
    total: run?.files.length ?? 0,
    read: run?.files.filter((f) => f.status === 'read').length ?? 0,
    failed: run?.files.filter((f) => f.status === 'failed').length ?? 0,
  }
  useEffect(() => {
    if (!runId || !waiting) return
    let gone = false
    const poll = async () => {
      // A refusal (the run expired or was removed, the month is no longer a draft) stops at once; a server or network
      // failure is tried again, five times in a row at most.
      let failures = 0
      while (!gone) {
        await new Promise((ok) => setTimeout(ok, 1500))
        if (gone) return
        try {
          const p = await apiRef.current.get<PayrollMatchProgress>(
            `/payroll-match/${runId}/progress`
          )
          if (gone) return
          failures = 0
          setProgress(p)
          if (p.read + p.failed >= p.total) {
            // All read: the run once more, with every match, as the page opens it.
            const done = await apiRef.current.get<PayrollMatchRunDto>(`/payroll-match/${runId}`)
            if (!gone) setRun(done)
            return
          }
        } catch (e) {
          if (gone) return
          const refused = e instanceof ApiError && e.status >= 400 && e.status < 500
          if (refused || ++failures >= 5) {
            setPollError((e as Error).message)
            return
          }
        }
      }
    }
    void poll()
    return () => {
      gone = true
    }
  }, [runId, waiting])
  const [discardError, setDiscardError] = useState<string | null>(null)
  const discard = async () => {
    if (!run) return
    setDiscardError(null)
    try {
      await api.del(`/payroll-match/${run.id}`)
    } catch (e) {
      // Already gone (removed elsewhere): nothing left to discard. Anything else keeps the upload as it is.
      if (!(e instanceof ApiError && e.status === 404)) {
        setDiscardError((e as Error).message)
        return
      }
    }
    setRun(null)
    setPicks({})
    setProgress(null)
    setPollError(null)
    setStep('Upload')
  }

  // With a run that replaces them, the month's earlier payroll files are left out of the grid until Save removes them.
  const kept = (ds: AttachedDocument<DocumentPurpose>[]) =>
    run?.replace
      ? ds.filter((d) => !PAYROLL_DOCUMENT_KINDS.includes(d.document.kind as PayrollDocumentKind))
      : ds
  const items: PayrollItem[] = [
    ...r.expenses
      .filter((e) => isPayrollLine(e))
      .map((e) => ({
        target: 'expense' as const,
        kind: 'staff' as const,
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
      id: w.id,
      title: w.participantName,
      sub: w.participantNumber,
      paid: payPeriodWords(w.payPeriodStart, w.payPeriodEnd),
      amount: w.grossAmount,
      documents: kept(w.documents),
    })),
  ]
  const files = run?.files ?? []
  const fileOf = (id: string) => files.find((f) => f.id === id)
  const has = (item: PayrollItem, slot: PayrollSlot) =>
    slot === 'bank'
      ? markedLine(item)
      : item.documents.find(
          (d) => d.purpose === PURPOSE[slot] && (slot !== 'stub' || d.document.kind === 'paystub')
        )
  const matchOf = (item: PayrollItem, slot: PayrollSlot) =>
    run?.slots.find((m) => m.target === item.target && m.id === item.id && m.slot === slot)
  // Proof already attached that AI found too: the grid shows the saved proof, so the "Matched by" line counts these.
  const aiOnFile = items.reduce(
    (n, item) =>
      n +
      slotsOf(item).filter(
        (slot) => has(item, slot) && matchOf(item, slot)?.candidates.some((c) => c.ai)
      ).length,
    0
  )
  const [picks, setPicks] = useState<Record<string, Partial<Record<PayrollSlot, string>>>>({})
  const pick = (item: PayrollItem, slot: PayrollSlot) =>
    picks[keyOf(item)]?.[slot] ?? (has(item, slot) ? '' : (matchOf(item, slot)?.pick ?? ''))
  const setPick = (item: PayrollItem, slot: PayrollSlot, v: string) =>
    setPicks((p) => ({ ...p, [keyOf(item)]: { ...p[keyOf(item)], [slot]: v } }))
  const candidate = (
    item: PayrollItem,
    slot: PayrollSlot,
    fileId: string
  ): PayrollCandidate | undefined =>
    matchOf(item, slot)?.candidates.find((c) => c.fileId === fileId)
  // A bank statement proves a payment only by its line: one picked where no line was found is not saved as proof,
  // and its payment goes on to Unmatched payments to have the line found there.
  const noLine = (item: PayrollItem, slot: PayrollSlot, fileId: string) =>
    slot === 'bank' && !candidate(item, slot, fileId)?.mark
  // Why each slot was filled or left empty, for "How Auto-Match decided".
  const whyOf = (item: PayrollItem, slot: PayrollSlot) => {
    const attached = has(item, slot)
    return slotWhy({
      attached: attached ? { file: attached.document.fileName } : null,
      chosen: picks[keyOf(item)]?.[slot],
      match: matchOf(item, slot),
      fileName: (id) => fileOf(id)?.fileName,
      noLine: (id) => noLine(item, slot, id),
      noLineText: 'No line for this payment was found on it: find it under Unmatched payments.',
    })
  }
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<{ timesheet: string; register: string }>({
    timesheet: '',
    register: '',
  })
  const [saving, setSaving] = useState(false)
  // How many earlier payroll files the last Save replaced, for the Done step.
  const [replaced, setReplaced] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const isProved = (i: PayrollItem) => slotsOf(i).every((slot) => has(i, slot))
  const openItems = items.filter((i) => !isProved(i))
  const staffItems = items.filter((i) => i.kind === 'staff')
  // The staff lines that left Match with no bank line: this step's list, kept as it was on arrival so a line found
  // here stays in view with its ✓.
  const [unmatched, setUnmatched] = useState<string[]>([])
  const unmatchedItems = staffItems.filter((i) => unmatched.includes(keyOf(i)))
  const stillUnmatched = unmatchedItems.filter((i) => !markedLine(i)).length
  const doneItems = items.filter(isProved)
  const proved = doneItems.length
  const q = search.trim().toLowerCase()
  const shown = q
    ? openItems.filter((i) => `${i.title} ${i.sub} ${i.amount}`.toLowerCase().includes(q))
    : openItems
  const allShown = shown.length > 0 && shown.every((i) => chosen.has(keyOf(i)))
  const toSave = items.flatMap((item) =>
    slotsOf(item)
      .filter(
        (slot) => !has(item, slot) && pick(item, slot) && !noLine(item, slot, pick(item, slot))
      )
      .map((slot) => {
        return { target: item.target, id: item.id, slot, fileId: pick(item, slot) }
      })
  )

  /** Start a run (with the zip's files, or none to match what is already on file) and send the files, 20 at a time. */
  const startRun = async (zip: { file: File; kind: PayrollFolderKind }[], replace: boolean) => {
    setRunError(null)
    setPollError(null)
    setDiscardError(null)
    setProgress(null)
    setReading('Starting…')
    try {
      let current = await api.post<PayrollMatchRunDto>(`/reports/${r.id}/payroll-match`, {
        replace,
      })
      for (let at = 0; at < zip.length; at += BATCH) {
        const batch = zip.slice(at, at + BATCH)
        setReading(`Sending files ${at + 1}–${at + batch.length} of ${zip.length}…`)
        const form = new FormData()
        for (const f of batch) {
          form.append('files', f.file)
          form.append('kinds', f.kind)
        }
        current = await api.upload<PayrollMatchRunDto>(`/payroll-match/${current.id}/files`, form)
      }
      setRun(current)
      setPicks({})
      setStep('Match')
    } catch (e) {
      setRunError((e as Error).message)
    } finally {
      setReading(null)
    }
  }

  /** Save, all at once on the server: the staged files are filed, every match is linked with its line, and (for a run
   * that replaces) the earlier files go. Until this runs the month is as it was. */
  const saveAll = async () => {
    if (!run) return true
    setSaving(true)
    setSaveError(null)
    try {
      // The month's payroll files before Save: a run that replaces removes every one of them.
      const removed = run.replace ? r.payrollDocuments.length : 0
      const report = await api.post<ReportDetail>(`/payroll-match/${run.id}/save`, {
        links: toSave,
      })
      const staged = run.files.filter((f) => f.staged).length
      setReplaced(removed)
      onChange(report)
      onNotice(
        [
          staged && `Filed ${staged} ${staged === 1 ? 'file' : 'files'}`,
          toSave.length && `saved ${toSave.length} ${toSave.length === 1 ? 'match' : 'matches'}`,
          removed && `replaced the ${removed} earlier ${removed === 1 ? 'file' : 'files'}`,
        ]
          .filter(Boolean)
          .join(', ') + '.'
      )
      setRun(null)
      setPicks({})
      setProgress(null)
      setChosen(new Set())
      return true
    } catch (e) {
      setSaveError((e as Error).message)
      return false
    } finally {
      setSaving(false)
    }
  }

  // What was highlighted, in words; a whole row is cut short.
  const wordsOf = (marks: StatementMark[]) =>
    marks
      .map((m) => m.text)
      .filter((t): t is string => !!t)
      .map((t) => (t.length > 48 ? `${t.slice(0, 46)}…` : t))
  /** Show, while matching: this file as the item's own copy, with only its highlights. */
  const show = (item: PayrollItem, slot: PayrollSlot, fileId: string) => {
    const f = fileOf(fileId)
    const c = candidate(item, slot, fileId)
    if (!f || !run) return
    const marks = c?.marks.length ? c.marks : c?.mark ? [c.mark] : []
    setViewing({
      title: `${item.title}: ${SLOT_LABEL[slot].toLowerCase()}`,
      doc: { id: f.id, sensitivity: f.personal ? 'personal' : 'financial', kind: f.kind },
      fileName: f.fileName,
      src: `/payroll-match/${run.id}/files/${f.id}/copy?target=${item.target}&id=${item.id}&slot=${slot}`,
      page: marks[0]?.page ?? 1,
      words: wordsOf(marks),
    })
  }
  /** Show, once saved: the proof as the item's own copy. */
  const showSaved = (
    item: PayrollItem,
    slot: PayrollSlot,
    a: AttachedDocument<DocumentPurpose>
  ) => {
    const marks = a.marks?.length ? a.marks : a.mark ? [a.mark] : []
    setViewing({
      title: `${item.title}: ${SLOT_LABEL[slot].toLowerCase()}`,
      doc: a.document,
      fileName: a.document.fileName,
      src: `/payroll/${item.target}/${item.id}/proof/${a.document.id}`,
      page: marks[0]?.page ?? 1,
      words: wordsOf(marks),
    })
  }

  const docSelect = (item: PayrollItem, slot: PayrollSlot) => {
    const attached = has(item, slot)
    if (attached) {
      if (slot === 'bank' && attached.mark)
        return (
          <>
            <Chip tone="ok" fill title={attached.document.fileName}>
              ✓ bank line, page {attached.mark.page}
            </Chip>{' '}
            <Button size="sm" kind="ghost" onClick={() => showSaved(item, slot, attached)}>
              show
            </Button>
          </>
        )
      const word = SLOT_LABEL[slot]
      const highlighted = !!(attached.marks?.length || attached.mark)
      return (
        <>
          <Chip tone="ok" fill title={attached.document.fileName}>
            {attached.document.sensitivity === 'personal' &&
            !PAYROLL_PERSONAL_KINDS.includes(attached.document.kind) &&
            !r.can.readPersonal ? (
              <>✓ {word}</>
            ) : (
              <DocumentLink doc={attached.document}>✓ {word}</DocumentLink>
            )}
          </Chip>
          {highlighted && (
            <>
              {' '}
              <Button size="sm" kind="ghost" onClick={() => showSaved(item, slot, attached)}>
                show
              </Button>
            </>
          )}
        </>
      )
    }
    if (!r.can.edit || !run) return <Chip tone="warn">missing</Chip>
    const options = files.filter((d) => d.kind === PAYROLL_SLOT_KIND[slot])
    const value = pick(item, slot)
    const auto = !picks[keyOf(item)]?.[slot] && !!value
    const c = value ? candidate(item, slot, value) : undefined
    // The cell says how sure it is: green when the line was found (or chosen by hand), amber for a guess or a bank
    // statement with no line found, red when missing.
    const state = !value
      ? 'missing'
      : noLine(item, slot, value)
        ? 'noline'
        : auto && !c?.sure
          ? 'guess'
          : 'ok'
    return (
      <>
        <select
          className={`${inputClass} ad-match-${state === 'noline' ? 'guess' : state}`}
          aria-label={`${slot} for ${item.title}`}
          value={value}
          onChange={(e) => setPick(item, slot, e.target.value)}
        >
          <option value="">{options.length ? 'Choose…' : 'None uploaded'}</option>
          {options.map((d) => (
            <option key={d.id} value={d.id}>
              {d.fileName}
              {d.scanned ? ' (scanned)' : ''}
            </option>
          ))}
        </select>
        <ProofFoot
          state={state === 'noline' ? 'guess' : state}
          text={
            state === 'missing'
              ? undefined
              : state === 'noline'
                ? '⚠️ No line found: next step'
                : state === 'guess'
                  ? '⚠️ ⚡ Best guess: check it'
                  : `✓ ${auto ? `${c?.ai ? '✨ Found by AI' : '⚡ Found'}${c?.mark ? `, page ${c.mark.page}` : ''}` : 'Chosen'}`
          }
          onShow={value && (c?.marks.length || c?.mark) ? () => show(item, slot, value) : undefined}
        />
      </>
    )
  }

  // Back and Save on the Match step, with or without payroll items: the zip's files are filed either way.
  const matchActions = (
    <MatchFooter
      error={discardError}
      onBack={() => setStep('Upload')}
      onDiscard={run ? () => void discard() : undefined}
      saving={saving}
      save={{
        label: saving
          ? 'Saving…'
          : waiting
            ? 'Reading the files…'
            : run
              ? 'Save and continue'
              : 'Next',
        disabled: saving || waiting || !!pollError,
        onClick: () =>
          void (async () => {
            // Staff lines still without a bank line after this save go on to Unmatched payments.
            const left = staffItems
              .filter(
                (i) => !has(i, 'bank') && (!pick(i, 'bank') || noLine(i, 'bank', pick(i, 'bank')))
              )
              .map(keyOf)
            if (!(await saveAll())) return
            setUnmatched(left)
            setStep(left.length ? 'Unmatched payments' : 'Done')
          })(),
      }}
    />
  )

  return (
    <Card
      className="mt-4"
      title="Payroll proof"
      aside={<ProvedCount proved={proved} total={items.length} />}
    >
      <Stepper steps={STEPS} current={step} />
      {run && step === 'Match' && waiting && (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <p className="text-sm font-semibold" role="status">
              <span className="ad-hourglass" aria-hidden="true">
                ⏳
              </span>{' '}
              Reading the files on the server: {shownProgress.read} of {shownProgress.total} done
              {shownProgress.failed ? `, ${shownProgress.failed} could not be read` : ''}
            </p>
            <span className="ad-progress" aria-hidden="true">
              <span
                style={{
                  width: `${shownProgress.total ? ((shownProgress.read + shownProgress.failed) / shownProgress.total) * 100 : 0}%`,
                }}
              />
            </span>
          </div>
          <HandCard
            title="Reading your files"
            icon="⏳"
            lead="You can close this: it keeps reading."
          >
            <p>When you open Match payroll &amp; timecards again, you pick up here.</p>
          </HandCard>
          {matchActions}
        </div>
      )}
      {run && step === 'Match' && pollError && (
        <>
          <ErrorNote message={pollError} />
          {matchActions}
        </>
      )}
      {run && step === 'Match' && !waiting && !pollError && (
        <UnsavedNote removing={run.replace ? r.payrollDocuments.length : 0} />
      )}
      {step === 'Unmatched payments' && <ErrorNote message={saveError} />}
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
              <li>
                Auto-Match reads every file and finds the line where each person&apos;s name and pay
                appear.
              </li>
              <li>Check the highlighted lines and save.</li>
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
            <>
              <ErrorNote message={runError} />
              {payrollAi && (
                <AiReadBox
                  available={payrollAi.available}
                  beta={payrollAi.beta}
                  names="the names of this month's participants"
                  checked={withAi}
                  onChange={setWithAi}
                />
              )}
              <UploadPanel
                existing={r.payrollDocuments.length}
                busy={reading}
                onReady={(zip, replace) => void startRun(zip, replace)}
                onSkip={r.payrollDocuments.length ? () => void startRun([], false) : undefined}
              />
            </>
          ) : (
            <div className="ad-actions justify-end">
              <Button kind="primary" onClick={() => setStep('Match')}>
                Next: match
              </Button>
            </div>
          )}
        </div>
      )}

      {atAi && <AiReadingNote progress={ai.progress} error={null} />}
      {step === 'Match' && !waiting && !pollError && !atAi && run && (
        <>
          {ai.error && <AiReadingNote progress={null} error={ai.error} />}
          <LineCapNotes files={run.files.filter((f) => f.overLineCap)} />
          {aiOnFile > 0 && (
            <p className="text-sm">
              ✨ AI also found {aiOnFile} {aiOnFile === 1 ? 'proof' : 'proofs'} already on file.
            </p>
          )}
        </>
      )}
      {step === 'Match' && !waiting && !pollError && !atAi && items.length === 0 && (
        <>
          <Empty>No payroll lines or work-experience payments this month.</Empty>
          <ErrorNote message={saveError} />
          {matchActions}
        </>
      )}
      {step === 'Match' && !waiting && !pollError && !atAi && items.length > 0 && (
        <>
          {openItems.length === 0 ? (
            <Empty>Auto-Match proved every payroll item this month.</Empty>
          ) : (
            <RemainingSection count={openItems.length}>
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
                      {files
                        .filter((d) => d.kind === PAYROLL_SLOT_KIND[slot])
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
                            {docSelect(item, item.kind === 'participant' ? 'stub' : 'bank')}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </RemainingSection>
          )}
          <ErrorNote message={saveError} />
          {openItems.length > 0 && (
            <WhyPanel
              source={run && <MatchedBy run={run} />}
              blocks={[
                ...openItems.map((item) => ({
                  key: keyOf(item),
                  title: item.title,
                  sub: `${item.paid} · ${money(item.amount)}`,
                  rows: slotsOf(item).map((slot) => ({
                    label: SLOT_LABEL[slot],
                    ...whyOf(item, slot),
                  })),
                })),
              ]}
            />
          )}
          {matchActions}
        </>
      )}

      {step === 'Unmatched payments' && (
        <div className="grid gap-4">
          <section className="mx-work" aria-label="Unmatched payments">
            <h3 className="mx-work-title">
              {stillUnmatched > 0 ? (
                <>
                  Remaining unmatched payments: <span className="mx-count">{stillUnmatched}</span>
                </>
              ) : (
                'Every payment here now has its bank line'
              )}
            </h3>
            <HandCard
              title="Prove these payments by hand"
              icon="🔎"
              lead="We couldn't find these payees' amounts among the bank statement's transactions."
            >
              <ol className="ad-hand-steps">
                <li>Press Find the bank line beside a payment.</li>
                <li>
                  Pick its transaction from the lines we found, or draw a box around it on the
                  statement. That box is what the auditor sees highlighted as its evidence of
                  payment.
                </li>
              </ol>
              <p>
                You can leave any of them for later: press Next. To come back, open Match payroll
                &amp; timecards and choose Skip: Re-attempt a match of existing uploaded files.
              </p>
            </HandCard>
            <ul className="mx-list">
              {unmatchedItems.map((item) => {
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
                          onClick={() => showSaved(item, 'bank', line)}
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

      {step === 'Done' && items.length === 0 && (
        // No payroll item to prove: say so, never "complete", and ask the person to confirm it was meant.
        <div className="grid gap-4">
          <HandCard
            title="No payroll this month"
            icon="🗓️"
            lead={`${periodLabel(r.period)} has no payroll lines and no participant pay, so there is nothing to prove here.`}
          >
            <ol className="ad-hand-steps">
              <li>No payroll this month? Then you are done here.</li>
              <li>Expected some? Add it with Add payroll on the month page, then come back.</li>
            </ol>
            {r.can.deleteMonth ? (
              <p>
                This month has nothing in it at all, so there is nothing to submit: you can delete
                it from More, Delete this month.
              </p>
            ) : (
              // What the server needs to let an owner delete it, as far as this screen can tell: a draft with no
              // expense, no payroll, no file and no reopening.
              r.status === 'draft' &&
              r.expenses.length === 0 &&
              r.wexPayments.length === 0 &&
              r.reopenings.length === 0 &&
              !r.signedCopy &&
              r.payrollDocuments.length === 0 &&
              !r.documents.some((d) => d.period === r.period) && (
                <p>
                  This month has nothing in it at all. If there is nothing to submit, ask an owner
                  to delete it.
                </p>
              )
            )}
          </HandCard>
          <div className="ad-actions justify-start">
            <Button kind="ghost" onClick={() => setStep('Upload')}>
              Back: upload
            </Button>
          </div>
        </div>
      )}
      {step === 'Done' && items.length > 0 && (
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
              <span className="ad-tile-label">Payroll files this month</span>
              <span className="ad-tile-value">{r.payrollDocuments.length}</span>
            </div>
            {replaced > 0 && (
              <div className="ad-tile">
                <span className="ad-tile-label">Earlier files replaced</span>
                <span className="ad-tile-value">{replaced}</span>
              </div>
            )}
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
        <Modal title={viewing.title} onClose={() => setViewing(null)} wide>
          <p className="mb-3 text-sm text-soft">
            {viewing.words.length ? (
              <>
                Highlighted for this item alone: <b>{viewing.words.join(' · ')}</b> ·{' '}
              </>
            ) : (
              'Nothing highlighted · '
            )}
            {viewing.fileName}
          </p>
          <StatementViewer
            doc={viewing.doc}
            src={viewing.src}
            page={viewing.page}
            downloadName={viewing.fileName}
          />
        </Modal>
      )}
    </Card>
  )
}

/** What one payroll zip may hold: the zip is opened in the browser, and its files go up 20 at a time. */
const ZIP_MAX_BYTES = 250 * 1024 * 1024
const ZIP_MAX_FILES = 200
/** The server's limit for one file (MAX_UPLOAD_BYTES in the API). */
export const FILE_MAX_BYTES = 25 * 1024 * 1024
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`

/**
 * Step 1: one zip with the four folders (Timesheets, Payroll registers, Pay stubs, Bank statements), opened in the
 * browser. Each folder sets its files' type; a zip laid out any other way is refused, with every problem at once.
 * The files then go up to the server, 20 at a time, to be read and matched; nothing is filed until Save.
 */
export function UploadPanel({
  existing,
  busy,
  onReady,
  onSkip,
  maxFiles = ZIP_MAX_FILES,
  action = 'Upload zip and match',
  kind = 'primary',
}: {
  /** Reading the files on the server: what to say on the button meanwhile. */
  busy: string | null
  /** How many payroll files the month already has: "Replace them" is offered when there are any. */
  existing: number
  /** The zip checked and sorted: send it to be read and matched. */
  onReady: (files: { file: File; kind: PayrollFolderKind }[], replace: boolean) => void
  /** Already uploaded this month: match those files again without uploading more. */
  onSkip?: () => void
  /** How many files the zip may hold (a workspace month's set holds more than one engagement's month). */
  maxFiles?: number
  /** The upload button's words. */
  action?: string
  /** The upload button's colour: navy where it is a step's Next (the workspace payroll page), green otherwise. */
  kind?: 'primary' | 'navy'
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
      if (sorted.files.length > maxFiles)
        setTooBig(
          `This zip has ${sorted.files.length.toLocaleString('en-US')} files; the limit is ${maxFiles.toLocaleString('en-US')}. Split it into two zips with the same four folders.`
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
        label="One zip with four folders: Timesheets, Payroll registers, Pay stubs and Bank statements (and Payroll details, when you have it), as in the sample above."
        required
        hint={`Up to ${mb(ZIP_MAX_BYTES)} and ${maxFiles.toLocaleString('en-US')} files; each file up to ${mb(FILE_MAX_BYTES)}.`}
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
          <Button kind="ghost" onClick={onSkip} disabled={!!busy}>
            Skip: Re-attempt a match of existing uploaded files
          </Button>
        )}
        <Button
          kind={kind}
          onClick={() => onReady(files, replace)}
          disabled={!files.length || problems.length > 0 || !!tooBig || !!busy}
        >
          {busy ?? action}
        </Button>
      </div>
    </div>
  )
}

/**
 * "Find the line": the month's bank statements searched for the item's amount. The person picks the line (or, when
 * nothing was found, draws the box by hand on the page) and confirms; the link is the item's evidence of payment.
 */
export function FindLineModal({
  item,
  onClose,
  onLinked,
}: {
  item: Pick<PayrollItem, 'target' | 'id' | 'title'>
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
        // The same guidance as the wizard's Unmatched payments step: it asks for the same thing.
        <div className="mb-4">
          {statements.some((s) => s.lines.length > 0) ? (
            <HandCard
              title="Pick the bank line"
              icon="🔎"
              lead={`These lines on this month's bank statement show ${money(search.amount)}.`}
            >
              <ol className="ad-hand-steps">
                <li>Pick the one that pays this item.</li>
                <li>
                  None of them? Draw a box around the right transaction on the statement instead.
                </li>
              </ol>
              <p>
                The line you pick is what the auditor sees highlighted as its evidence of payment.
              </p>
            </HandCard>
          ) : (
            <HandCard
              title="Prove this payment by hand"
              icon="🔎"
              lead={`We couldn't find ${money(search.amount)} among this month's bank transactions.`}
            >
              <ol className="ad-hand-steps">
                <li>Press Draw the box by hand under the statement.</li>
                <li>
                  Drag a box around the transaction that pays this item. That box is what the
                  auditor sees highlighted as its evidence of payment.
                </li>
              </ol>
              <p>
                Not sure yet? Cancel and come back later from this row&apos;s Evidence of payment.
              </p>
            </HandCard>
          )}
        </div>
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
              kind={s.lines.length ? 'ghost' : 'navy'}
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
