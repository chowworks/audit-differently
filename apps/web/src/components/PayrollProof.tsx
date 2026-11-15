import { Suspense, cloneElement, lazy, useEffect, useRef, useState } from 'react'
import {
  andList,
  PAYROLL_PERSONAL_KINDS,
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
  type ReceiptUploadResult,
  type ReportDetail,
  type StatementMark,
} from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import {
  PAYROLL_FOLDERS,
  OPTIONAL_FOLDERS,
  PROGRAM_NAMES_FOLDER,
  ACCOUNT_MAPPING_FOLDER,
  RECEIPTS_FOLDER,
  filesFromZip,
  sortPayrollZip,
  type PayrollFolderKind,
} from '@/lib/zip-files'
import { HandCard } from '@/components/HandCard'
import './match-pairs.css'
import {
  Analyzing,
  DESIGN_STEPS,
  SaveCapture,
  type CaptureRow,
  StepHead,
  StepRail,
  railSteps,
  type DesignStep,
} from '@/components/payroll-match/StepperDesign'
import { money, payPeriodWords, periodLabel, shortDate } from '@/lib/format'
import { DocumentLink } from '@/components/DocumentLink'
import {
  MatchFooter,
  ProofFoot,
  ProvedCount,
  LineCapNotes,
  CancelButton,
} from '@/components/payroll-match/MatchParts'
import {
  AiReadBox,
  AiReadingNote,
  useAiAfterUpload,
  usePayrollAi,
} from '@/components/payroll-match/AiReadBox'
import { SLOT_LABEL } from '@/components/payroll-match/why'
import {
  StaffReview,
  type ReviewRow,
  type ReviewSlot,
} from '@/components/payroll-match/StaffReview'
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
  onDone,
}: {
  report: ReportDetail
  onChange: (report: ReportDetail) => void
  onNotice: (text: string) => void
  /** Closes the wizard: the stepper's Done on its last step. */
  onDone?: () => void
}) {
  // An opening picks up the person's unsaved run of the month (the job keeps reading while the wizard is closed);
  // without one it starts at Upload.
  const [step, setStep] = useState<
    'Upload' | 'Payroll matching' | 'Unmatched payments' | 'Summary'
  >('Upload')
  // The match split into its steps, after an animated "Analyzing" step.
  const [analyzed, setAnalyzed] = useState(false)
  /** The analysis has played once for this run: Back shows it finished. */
  const [played, setPlayed] = useState(false)
  /** Its last stage has run: the rail's step 2 stops spinning. */
  const [analysisDone, setAnalysisDone] = useState(false)
  const [part, setPart] = useState<'staff' | 'participant'>('staff')
  // Save and finish: its lines land first, then each is stamped saved.
  const [stamped, setStamped] = useState(false)
  useEffect(() => {
    if (step !== 'Summary') return setStamped(false)
    const t = setTimeout(() => setStamped(true), 1100)
    return () => clearTimeout(t)
  }, [step])
  useEffect(() => {
    if (step === 'Upload') {
      setAnalyzed(false)
      setPlayed(false)
      setPart('staff')
    }
  }, [step])
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
        setStep('Payroll matching')
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
  const atAi = step === 'Payroll matching' && !!run && !waiting && !pollError && ai.reading
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
    setConfirmed(new Set())
    setProgress(null)
    setPollError(null)
    setStep('Upload')
    // Cancel leaves the wizard (owner's ask, 2026-11-15), not just its first step.
    onDone?.()
  }

  // With a run that replaces them, the month's earlier payroll files are left out of the grid until Save removes them.
  // The workspace's files (the owner's Month End Close upload) stay: replacing never removes them.
  const kept = (ds: AttachedDocument<DocumentPurpose>[]) =>
    run?.replace
      ? ds.filter(
          (d) =>
            d.document.workspace ||
            !PAYROLL_DOCUMENT_KINDS.includes(d.document.kind as PayrollDocumentKind)
        )
      : ds
  // The engagement's own payroll files of the month: the ones a replacing Save removes.
  const ownFiles = r.payrollDocuments.filter((d) => !d.workspace).length
  const workspaceFiles = r.payrollDocuments.length - ownFiles
  const items: PayrollItem[] = [
    ...r.expenses
      // A books' payroll transaction the match covers shows in the reconciliation only, as on the owner's match.
      .filter((e) => isPayrollLine(e) && e.counts)
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
  /** Best guesses the person confirmed (owner's decision, 2026-11-14, as on the owner's match): only these are saved. */
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const slotId = (item: PayrollItem, slot: PayrollSlot) => `${keyOf(item)}-${slot}`
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
  // Auto-Match's own pick that is a guess, not chosen by hand and not confirmed: not saved.
  const unsure = (item: PayrollItem, slot: PayrollSlot, fileId: string) =>
    !picks[keyOf(item)]?.[slot] &&
    !candidate(item, slot, fileId)?.sure &&
    !confirmed.has(slotId(item, slot))
  // The files a slot may take: a staff line only what its own people's rows prove, as on the owner's match (the
  // server offers nothing else); a participant's pay any file of the kind.
  const offered = (item: PayrollItem, slot: PayrollSlot) => {
    const ofKind = files.filter((d) => d.kind === PAYROLL_SLOT_KIND[slot])
    if (item.kind !== 'staff') return ofKind
    const ids = new Set(matchOf(item, slot)?.candidates.map((c) => c.fileId))
    return ofKind.filter((d) => ids.has(d.id))
  }
  // A bank statement proves a payment only by its line: one picked where no line was found is not saved as proof,
  // and its payment goes on to Unmatched payments to have the line found there.
  const noLine = (item: PayrollItem, slot: PayrollSlot, fileId: string) =>
    slot === 'bank' && !candidate(item, slot, fileId)?.mark
  // What the zip's Receipts folder did: added and matched, and any left out.
  const [receiptsLeft, setReceiptsLeft] = useState<string | null>(null)
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
  // Complete after Save, as Payroll & Proof counts it: every proof on file or chosen here (a bank statement with its
  // line), none a guess and none a second file that disagrees with the one on file.
  const proved = items.filter((i) =>
    slotsOf(i).every((slot) => {
      if (has(i, slot)) return true
      const v = pick(i, slot)
      if (!v || noLine(i, slot, v)) return false
      const auto = !picks[keyOf(i)]?.[slot]
      const m = matchOf(i, slot)
      return !auto || (!unsure(i, slot, v) && !m?.twoProofs)
    })
  ).length
  const countOf = (kind: 'staff' | 'participant') => {
    const all = items.filter((i) => i.kind === kind).length
    const left = openItems.filter((i) => i.kind === kind).length
    return { all, left, proved: all - left }
  }
  const toSave = items.flatMap((item) =>
    slotsOf(item)
      .filter(
        (slot) =>
          !has(item, slot) &&
          pick(item, slot) &&
          !noLine(item, slot, pick(item, slot)) &&
          // A best guess is saved only once confirmed, as on the owner's match.
          !unsure(item, slot, pick(item, slot))
      )
      .map((slot) => {
        return { target: item.target, id: item.id, slot, fileId: pick(item, slot) }
      })
  )

  // What Save will do, as the owner's match says it beside its footer: the files, the proofs, what needs a look.
  const twoFiles = items.flatMap((item) =>
    slotsOf(item)
      .filter((slot) => {
        const v = pick(item, slot)
        return (
          !has(item, slot) && !!v && !picks[keyOf(item)]?.[slot] && matchOf(item, slot)?.twoProofs
        )
      })
      .map((slot) => ({ key: `${keyOf(item)}-${slot}`, title: item.title, slot }))
  )
  const guesses = items.reduce(
    (n, item) =>
      n +
      slotsOf(item).filter((slot) => {
        const v = pick(item, slot)
        return !has(item, slot) && !!v && !noLine(item, slot, v) && unsure(item, slot, v)
      }).length,
    0
  )
  const saveWords = run && (
    <section aria-label="What Save will do">
      <h3 className="mx-work-title">What Save will do</h3>
      <ul className="grid list-disc gap-1 pl-5 text-sm">
        <li>
          <b>Files:</b>{' '}
          {[
            `${run.files.filter((f) => f.staged).length} new to file`,
            `${run.files.filter((f) => !f.staged).length} already on file`,
            ...(run.replace && ownFiles
              ? [`${ownFiles} earlier ${ownFiles === 1 ? 'file' : 'files'} removed`]
              : []),
          ].join(', ')}
          .
        </li>
        <li>
          <b>
            {toSave.length} {toSave.length === 1 ? 'proof' : 'proofs'} to link
          </b>
          , each with its line highlighted.
        </li>
        {guesses > 0 && (
          <li>
            <b>
              {guesses} best {guesses === 1 ? 'guess' : 'guesses'} not saved
            </b>{' '}
            until you press Confirm or choose the file.
          </li>
        )}
        {twoFiles.length > 0 && (
          <li>
            <b>⚠️ Two different files as one proof</b> (both are kept):
            <ul className="mt-1 grid gap-0.5">
              {twoFiles.map((t) => (
                <li key={t.key}>
                  {t.title}: two different {SLOT_LABEL[t.slot].toLowerCase()} files, check which is
                  right
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
    </section>
  )

  /** Start a run (with the zip's files, or none to match what is already on file) and send the files, 20 at a time. */
  const startRun = async (
    zip: { file: File; kind: PayrollFolderKind }[],
    replace: boolean,
    receipts: File[] = []
  ) => {
    setRunError(null)
    setPollError(null)
    setDiscardError(null)
    setProgress(null)
    setReceiptsLeft(null)
    setReading('Starting…')
    try {
      if (receipts.length) await addReceipts(receipts)
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
      setConfirmed(new Set())
      setStep('Payroll matching')
    } catch (e) {
      setRunError((e as Error).message)
    } finally {
      setReading(null)
    }
  }

  /**
   * The zip's Receipts folder (owner's decision, 2026-11-14: a bookkeeper adds their engagement's receipts): filed on
   * this month and matched to its expenses at once, as Match receipts does, before the payroll files go up. They never
   * stop the payroll files: a receipt that is too large or refused is left out, by name, in a warning.
   */
  const addReceipts = async (list: File[]) => {
    const left: string[] = [...(oversizeExpenseFiles([], list) ?? [])]
    const fit = list.filter((f) => f.size <= RECEIPT_MAX_BYTES)
    const url = `/reports/${r.id}/receipts`
    let added = 0
    let matched = 0
    let skipped = 0
    let report: ReportDetail | null = null
    const send = async (batch: File[]) => {
      const form = new FormData()
      for (const f of batch) form.append('files', f)
      const out = await api.upload<ReceiptUploadResult>(url, form)
      added += out.uploaded
      matched += out.matched
      skipped += out.skipped
      report = out.report
    }
    for (let at = 0; at < fit.length; at += BATCH) {
      const batch = fit.slice(at, at + BATCH)
      setReading(`Reading receipts ${at + 1}–${at + batch.length} of ${fit.length}…`)
      try {
        await send(batch)
      } catch {
        // One refused receipt refuses its batch: each sent on its own, so only the one at fault is left out.
        for (const f of batch)
          try {
            await send([f])
          } catch (e) {
            left.push(`${RECEIPTS_FOLDER}/${f.name} (${(e as Error).message})`)
          }
      }
    }
    if (report) onChange(report)
    setReceiptsLeft(
      [
        added &&
          `Added ${added} ${added === 1 ? 'receipt' : 'receipts'} to this month's expenses, ${matched} matched.`,
        skipped &&
          `${skipped} ${skipped === 1 ? 'receipt was' : 'receipts were'} already on this month, not added again.`,
        left.length && `Left out, the payroll files went up all the same: ${left.join('; ')}.`,
      ]
        .filter(Boolean)
        .join(' ') || null
    )
  }

  /** Save, all at once on the server: the staged files are filed, every match is linked with its line, and (for a run
   * that replaces) the earlier files go. Until this runs the month is as it was. */
  const saveAll = async () => {
    if (!run) return true
    setSaving(true)
    setSaveError(null)
    try {
      // The month's payroll files before Save: a run that replaces removes every one of them.
      const removed = run.replace ? ownFiles : 0
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
      setConfirmed(new Set())
      setProgress(null)
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
    const options = offered(item, slot)
    const value = pick(item, slot)
    const auto = !picks[keyOf(item)]?.[slot] && !!value
    const c = value ? candidate(item, slot, value) : undefined
    // The cell says how sure it is: green when the line was found (or chosen by hand), amber for a guess or a bank
    // statement with no line found, red when missing.
    const state = !value
      ? 'missing'
      : noLine(item, slot, value)
        ? 'noline'
        : (auto && unsure(item, slot, value)) || (auto && matchOf(item, slot)?.twoProofs)
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
          <option value="">
            {options.length ? 'Choose…' : item.kind === 'staff' ? 'None found' : 'None uploaded'}
          </option>
          {options.map((d) => (
            <option key={d.id} value={d.id}>
              {d.fileName}
              {d.status === 'failed'
                ? ' (no text found, check it by eye)'
                : d.scanned
                  ? ' (scanned)'
                  : ''}
            </option>
          ))}
        </select>
        <ProofFoot
          state={state === 'noline' ? 'guess' : state}
          text={
            state === 'missing'
              ? undefined
              : auto && matchOf(item, slot)?.twoProofs
                ? '⚠️ A different file is already on file: check which is right'
                : state === 'noline'
                  ? '⚠️ No line found: next step'
                  : state === 'guess'
                    ? '⚠️ ⚡ Best guess: check it'
                    : files.find((d) => d.id === value)?.status === 'failed'
                      ? '✓ Chosen: no text found, check it by eye'
                      : `✓ ${auto ? (confirmed.has(slotId(item, slot)) ? 'Confirmed' : `${c?.ai ? '✨ Found by AI' : '⚡ Found'}${c?.mark ? `, page ${c.mark.page}` : ''}`) : 'Chosen'}`
          }
          onShow={value && (c?.marks.length || c?.mark) ? () => show(item, slot, value) : undefined}
        >
          {state === 'guess' && auto && unsure(item, slot, value) && (
            <button
              type="button"
              className="ad-match-show"
              onClick={() => setConfirmed((x) => new Set(x).add(slotId(item, slot)))}
            >
              Confirm
            </button>
          )}
        </ProofFoot>
      </>
    )
  }

  // Steps 3 and 4 as the owner's match shows them (owner's choice, 2026-11-15): the reconciliation's grid.
  const reviewSlot = (item: PayrollItem, slot: PayrollSlot): ReviewSlot => {
    const label = SLOT_LABEL[slot]
    const attached = has(item, slot)
    if (attached)
      return {
        label,
        state: 'ok',
        file: attached.document.fileName,
        onShow:
          attached.marks?.length || attached.mark
            ? () => showSaved(item, slot, attached)
            : undefined,
      }
    if (!r.can.edit || !run) return { label, state: 'missing', problem: 'not on file' }
    const value = pick(item, slot)
    const fileName = value ? fileOf(value)?.fileName : undefined
    const auto = !picks[keyOf(item)]?.[slot] && !!value
    const fix = offered(item, slot).length ? docSelect(item, slot) : undefined
    if (!value)
      return {
        label,
        state: 'missing',
        problem: offered(item, slot).length
          ? `no line for this pay was found in any ${label.toLowerCase()} file: choose the file`
          : files.some((d) => d.kind === PAYROLL_SLOT_KIND[slot])
            ? `no ${label.toLowerCase()} names ${item.kind === 'staff' ? 'the people on this line' : 'this participant'}`
            : `no ${label.toLowerCase()} in your zip`,
        fix,
      }
    if (noLine(item, slot, value))
      return {
        label,
        state: 'guess',
        file: fileName,
        problem: `no line for this pay was found in ${fileName}: find it on Find missing bank lines`,
        fix,
      }
    if (auto && matchOf(item, slot)?.twoProofs)
      return {
        label,
        state: 'guess',
        file: fileName,
        problem: 'a different file is already on file: check which is right',
        fix,
      }
    if (auto && unsure(item, slot, value))
      return {
        label,
        state: 'guess',
        file: fileName,
        problem: `best guess ${fileName}: check it and confirm`,
        fix,
      }
    return {
      label,
      state: 'ok',
      file: fileName,
      onShow: () => show(item, slot, value),
    }
  }
  const reviewRows: ReviewRow[] = items
    .filter((i) => i.kind === part)
    .map((i) => ({
      key: keyOf(i),
      engagementId: r.engagement.id,
      engagementName: r.engagement.name,
      // The month itself: its group has no link to it.
      reportId: '',
      title: i.title,
      sub: i.sub,
      date: i.paid,
      amount: i.amount,
      slots: slotsOf(i).map((slot) => reviewSlot(i, slot)),
    }))

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
            // Find missing bank lines only when a staff line has no bank line (owner's decision, 2026-11-15).
            setStep(left.length ? 'Unmatched payments' : 'Summary')
          })(),
      }}
    />
  )

  // The bookkeeper's flow has no expenses step.
  const designSteps = DESIGN_STEPS.filter((x) => x !== 'Review expenses' && x !== 'Summary')
  const staffCount = countOf('staff')
  const partCount = countOf('participant')
  const leftToDo = items.length - proved
  const finishRows: CaptureRow[] = [
    { label: 'Payroll files saved on this month', value: r.payrollDocuments.length },
    {
      label: 'Staff pays with all their proof',
      value: `${staffCount.proved} of ${staffCount.all}`,
      warn: staffCount.left > 0,
    },
    {
      label: 'Participant pays with all their proof',
      value: `${partCount.proved} of ${partCount.all}`,
      warn: partCount.left > 0,
    },
    {
      label: 'Staff pays found on the bank statement',
      value: `${staffItems.filter((i) => has(i, 'bank')).length} of ${staffItems.length}`,
    },
    ...(replaced ? [{ label: 'Earlier files replaced', value: replaced }] : []),
    ...(leftToDo
      ? [{ label: 'Still to do: pays missing proof', value: leftToDo, warn: true }]
      : []),
  ]
  const proofWords = (c: { all: number; left: number; proved: number }) =>
    c.all
      ? `${c.proved} of ${c.all} proved${c.left ? ` · ${c.left} to match` : ''}`
      : 'None this month'
  const designAt: DesignStep =
    step === 'Upload'
      ? 'Upload your files'
      : step === 'Unmatched payments'
        ? 'Find missing bank lines'
        : step === 'Summary'
          ? 'Save and finish'
          : !analyzed || waiting
            ? 'Analyzing and reconciling'
            : part === 'staff'
              ? 'Review staff payroll'
              : 'Review participant pay'
  const reviewed = step === 'Unmatched payments' || step === 'Summary' || (analyzed && !waiting)
  const designRail = railSteps(
    designSteps,
    designAt,
    {
      ...(run
        ? {
            'Analyzing and reconciling': {
              note: waiting
                ? `Reading… ${shownProgress.read} of ${shownProgress.total}`
                : `${shownProgress.read} read`,
            },
          }
        : {}),
      ...(reviewed
        ? {
            'Review staff payroll': {
              note: proofWords(staffCount),
              ...(staffCount.left ? { tone: 'warn' as const } : {}),
            },
            'Review participant pay': {
              note: proofWords(partCount),
              ...(partCount.left ? { tone: 'warn' as const } : {}),
            },
          }
        : {}),
      ...(step === 'Summary' || step === 'Unmatched payments'
        ? {
            'Find missing bank lines': stillUnmatched
              ? { note: `${stillUnmatched} with no bank line`, tone: 'danger' as const }
              : { note: 'All found' },
          }
        : {}),
    },
    designAt === 'Analyzing and reconciling' && (waiting || (!analyzed && !analysisDone))
  )
  const analyzing = step === 'Payroll matching' && !!run && !pollError && (waiting || !analyzed)
  const card = (
    <Card
      className="mt-4"
      title="Payroll proof"
      aside={<ProvedCount proved={proved} total={items.length} />}
    >
      {step === 'Upload' && <StepHead n={1} of={designSteps.length} title="Upload your files" />}
      {analyzing && run && (
        <>
          <StepHead
            n={2}
            of={designSteps.length}
            title="Analyzing and reconciling"
            did={`We're reading your ${run.files.length} files and matching every pay on ${periodLabel(r.period)} to its proof.`}
          />
          <Analyzing
            instant={played}
            onFinished={setAnalysisDone}
            files={run.files}
            progress={shownProgress}
            read={!waiting && !atAi}
            stages={[
              {
                title: 'Found the pay in them',
                did: 'Register rows, pay stubs and payroll details: whose pay, which period, how much.',
                result: `${run.runs.length} ${run.runs.length === 1 ? 'pay run' : 'pay runs'}`,
              },
              {
                title: 'Staff pay lines → their proof',
                did: 'Each staff line, against its timesheet and register row.',
                result: proofWords(staffCount),
              },
              {
                title: 'Participant pay → their stubs',
                did: "Each participant's pay, against their pay stub and the register.",
                result: proofWords(partCount),
              },
              {
                title: 'Pay runs → the bank statement',
                did: "Each run's one direct-deposit debit, against the register's total.",
                result: `${run.files.filter((f) => f.kind === 'bank-statement').length} checked`,
              },
            ]}
            back={
              <span className="flex items-center gap-3">
                <Button kind="ghost" onClick={() => setStep('Upload')}>
                  Back: upload
                </Button>
                <CancelButton onCancel={() => void discard()} />
              </span>
            }
            next={
              <Button
                kind="navy"
                onClick={() => {
                  setAnalyzed(true)
                  setPlayed(true)
                }}
              >
                Next: review staff payroll →
              </Button>
            }
          />
        </>
      )}
      {analyzed && step === 'Payroll matching' && run && !waiting && !pollError && !atAi && (
        <>
          <StepHead
            n={part === 'staff' ? 3 : 4}
            of={designSteps.length}
            title={part === 'staff' ? 'Review staff payroll' : 'Review participant pay'}
            did={
              part === 'staff'
                ? "For each staff pay line, we looked for the person's timesheet, their row in the payroll register and their pay run on the bank statement."
                : "For each participant's pay, we looked for their pay stub, their row in the payroll register and their timesheet."
            }
          />
        </>
      )}
      {step === 'Unmatched payments' && (
        <StepHead
          n={5}
          of={designSteps.length}
          title="Find missing bank lines"
          did="Every pay has to show up as money leaving your bank. Your bank shows each pay run as one direct-deposit debit, so we looked for that debit on the statement."
        />
      )}
      {run && step === 'Payroll matching' && pollError && (
        <>
          <ErrorNote message={pollError} />
          {matchActions}
        </>
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
                Upload the month&apos;s payroll zip, in the sample&apos;s folders: timesheets,
                registers, pay stubs, bank statements and receipts.
              </li>
              <li>We read every file and match each pay to its proof.</li>
              <li>You check what needs you, step by step, then finish.</li>
            </ol>
            <p>Evidence of payment: a pay stub for participants, the bank line for staff.</p>
            <p className="ad-hand-address">
              <span className="ad-hand-address-label">Already in {periodLabel(r.period)}</span>
              <span>
                {PAYROLL_FOLDERS.map(([name, k]) => {
                  const n = r.payrollDocuments.filter((d) => d.kind === k).length
                  return `${name}: ${n}`
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
                existing={ownFiles}
                workspaceFiles={workspaceFiles}
                busy={reading}
                takesReceipts
                onReady={(zip, replace, _names, _mappings, receipts) =>
                  void startRun(zip, replace, receipts)
                }
                onSkip={r.payrollDocuments.length ? () => void startRun([], false) : undefined}
              />
            </>
          ) : (
            <div className="ad-actions justify-end">
              <Button kind="primary" onClick={() => setStep('Payroll matching')}>
                Next: match
              </Button>
            </div>
          )}
        </div>
      )}

      {atAi && <AiReadingNote progress={ai.progress} error={null} />}
      {step === 'Payroll matching' && !waiting && !pollError && !atAi && run && (
        <>
          {ai.error && <AiReadingNote progress={null} error={ai.error} />}
          {receiptsLeft && (
            <Notice tone={receiptsLeft.includes('Left out') ? 'warn' : 'ok'}>{receiptsLeft}</Notice>
          )}
          <LineCapNotes files={run.files.filter((f) => f.overLineCap)} />
          {aiOnFile > 0 && (
            <p className="text-sm">
              ✨ AI also found {aiOnFile} {aiOnFile === 1 ? 'proof' : 'proofs'} already on file.
            </p>
          )}
        </>
      )}
      {step === 'Payroll matching' && !waiting && !pollError && !atAi && items.length === 0 && (
        <>
          <Empty>No payroll lines or work-experience payments this month.</Empty>
          <ErrorNote message={saveError} />
          {saveWords}
          {matchActions}
        </>
      )}
      {step === 'Payroll matching' &&
        !waiting &&
        !pollError &&
        !atAi &&
        items.length > 0 &&
        analyzed && (
          <>
            <StaffReview key={part} rows={reviewRows} />
            <ErrorNote message={saveError} />
            {part === 'staff' ? (
              <MatchFooter
                onBack={() => setAnalyzed(false)}
                backLabel="Back: analyzing"
                onDiscard={run ? () => void discard() : undefined}
                saving={false}
                save={{
                  label: 'Next: review participant pay →',
                  disabled: false,
                  onClick: () => setPart('participant'),
                }}
              />
            ) : (
              // Saved quietly on Next (owner's decision, 2026-11-15): the celebration is at the end.
              <>
                {cloneElement(matchActions, {
                  onBack: () => setPart('staff'),
                  backLabel: 'Back: staff payroll',
                  save: {
                    ...matchActions.props.save,
                    label: saving
                      ? 'Saving…'
                      : staffItems.some(
                            (i) =>
                              !has(i, 'bank') &&
                              (!pick(i, 'bank') || noLine(i, 'bank', pick(i, 'bank')))
                          )
                        ? 'Next: find missing bank lines →'
                        : 'Next: save and finish →',
                  },
                })}
              </>
            )}
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
            {stillUnmatched > 0 && (
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
                  &amp; timecards and re-run matching with the saved files.
                </p>
              </HandCard>
            )}
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
            <Button
              kind="ghost"
              onClick={() => {
                setStep('Payroll matching')
                setPart('participant')
              }}
            >
              Back: participant pay
            </Button>
            <Button kind="navy" onClick={() => setStep('Summary')}>
              Next: save and finish →
            </Button>
          </div>
        </div>
      )}

      {step === 'Summary' && items.length === 0 && (
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
      {step === 'Summary' && items.length > 0 && (
        <div className="grid gap-4">
          <StepHead
            n={designSteps.indexOf('Save and finish') + 1}
            of={designSteps.length}
            title="Save and finish"
            did={
              stamped
                ? `Saved. Here is what we saved for ${periodLabel(r.period)}'s payroll. Anything still to do stays on the month page.`
                : `Saving ${periodLabel(r.period)}'s payroll…`
            }
          />
          <SaveCapture
            period={periodLabel(r.period)}
            saved={stamped}
            rows={finishRows}
            footer={
              <div className="ad-actions justify-between">
                <Button
                  kind="ghost"
                  onClick={() => {
                    if (unmatchedItems.length) return setStep('Unmatched payments')
                    setStep('Payroll matching')
                    setPart('participant')
                  }}
                >
                  {unmatchedItems.length
                    ? 'Back: find missing bank lines'
                    : 'Back: participant pay'}
                </Button>
                {onDone && (
                  <Button kind="navy" onClick={onDone} disabled={!stamped}>
                    Done
                  </Button>
                )}
              </div>
            }
          />
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
  return <StepRail steps={designRail}>{card}</StepRail>
}

/** What one payroll zip may hold: the zip is opened in the browser, and its files go up 20 at a time. */
const ZIP_MAX_BYTES = 250 * 1024 * 1024
const ZIP_MAX_FILES = 200
/** The server's limit for a program names file (MAX_IMPORT_BYTES in the API). */
const NAMES_MAX_BYTES = 5 * 1024 * 1024
/** The server's limit for one file (MAX_UPLOAD_BYTES in the API). */
export const FILE_MAX_BYTES = 25 * 1024 * 1024
/** The server's limit for an account mapping file (the account-mappings upload in the API). */
export const MAPPING_MAX_BYTES = 5 * 1024 * 1024
/** The server's limit for one receipt (the expenses receipts upload in the API). */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024
export const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`

/**
 * The zip's expense files over the server's limits, by folder and name: left out of the upload, never in the way of the
 * payroll files. Null when none is.
 */
export function oversizeExpenseFiles(mappings: File[], receipts: File[]) {
  const big = [
    ...mappings
      .filter((f) => f.size > MAPPING_MAX_BYTES)
      .map((f) => `${ACCOUNT_MAPPING_FOLDER}/${f.name} (over ${mb(MAPPING_MAX_BYTES)})`),
    ...receipts
      .filter((f) => f.size > RECEIPT_MAX_BYTES)
      .map((f) => `${RECEIPTS_FOLDER}/${f.name} (over ${mb(RECEIPT_MAX_BYTES)})`),
  ]
  return big.length ? big : null
}

/**
 * Step 1: one zip with the sample's folders (Timesheets, Payroll registers, Bank & card statements; Pay stubs, QuickBooks transactions, Program names and Account mapping when the team has them), opened in the
 * browser. Each folder sets its files' type; a zip laid out any other way is refused, with every problem at once.
 * The files then go up to the server, 20 at a time, to be read and matched; nothing is filed until Save.
 */
export function UploadPanel({
  existing,
  workspaceFiles = 0,
  busy,
  onReady,
  onSkip,
  replaceFirst = false,
  maxFiles = ZIP_MAX_FILES,
  action = 'Upload zip and match',
  kind = 'primary',
  takesNames = false,
  takesReceipts = takesNames,
}: {
  /** Whether this screen files a Receipts folder (both match screens; a bookkeeper's on their own month). */
  takesReceipts?: boolean
  /**
   * Whether this screen reads a Program names folder (the owner's workspace match); elsewhere the zip's names files are
   * said to be read there, and are not sent.
   */
  takesNames?: boolean
  /** Reading the files on the server: what to say on the button meanwhile. */
  busy: string | null
  /** How many payroll files the month already has: "Replace them" is offered when there are any. */
  existing: number
  /** The month's workspace payroll files (Month End Close), which replacing leaves in place. */
  workspaceFiles?: number
  /**
   * The zip checked and sorted: send it to be read and matched. `names`: its "Program names" files, which are not proof
   * (the workspace's program names, merged from them).
   */
  onReady: (
    files: { file: File; kind: PayrollFolderKind }[],
    replace: boolean,
    names: File[],
    /** Its "Account mapping" files: not proof either (each engagement's account mapping). */
    mappings: File[],
    /** Its "Receipts" files: the receipts of the books' bills, for the expenses step. */
    receipts: File[]
  ) => void
  /** Already uploaded this month: match those files again without uploading more. */
  onSkip?: () => void
  /** "Replace them" starts ticked (the workspace match's "Re-match with new files"). */
  replaceFirst?: boolean
  /** How many files the zip may hold (a workspace month's set holds more than one engagement's month). */
  maxFiles?: number
  /** The upload button's words. */
  action?: string
  /** The upload button's colour: navy where it is a step's Next (the workspace payroll page), green otherwise. */
  kind?: 'primary' | 'navy'
}) {
  const [zipName, setZipName] = useState<string | null>(null)
  const [files, setFiles] = useState<{ file: File; kind: PayrollFolderKind; folder: string }[]>([])
  const [names, setNames] = useState<File[]>([])
  const [mappings, setMappings] = useState<File[]>([])
  const [receipts, setReceipts] = useState<File[]>([])
  const [problems, setProblems] = useState<string[]>([])
  // Too big to take: the zip, the number of files, or one file over the server's limit. Said as it is, not as a layout problem.
  const [tooBig, setTooBig] = useState<string | null>(null)
  const [replace, setReplace] = useState(replaceFirst)
  const choose = async (zip: File | undefined) => {
    setFiles([])
    setNames([])
    setMappings([])
    setReceipts([])
    setProblems([])
    setTooBig(null)
    setZipName(zip?.name ?? null)
    if (!zip) return
    if (zip.size > ZIP_MAX_BYTES) {
      setTooBig(
        `This zip is ${mb(zip.size)}; the limit is ${mb(ZIP_MAX_BYTES)}. Split the month into two zips with the same folders.`
      )
      return
    }
    if (!/\.zip$/i.test(zip.name)) {
      setProblems(["Choose a .zip file with the sample's folders."])
      return
    }
    try {
      const opened = await filesFromZip(zip)
      const sorted = sortPayrollZip(opened.files, opened.skipped)
      const big = sorted.files.filter((f) => f.file.size > FILE_MAX_BYTES)
      if (sorted.files.length > maxFiles)
        setTooBig(
          `This zip has ${sorted.files.length.toLocaleString('en-US')} files; the limit is ${maxFiles.toLocaleString('en-US')}. Split it into two zips with the same folders.`
        )
      else if (big.length)
        setTooBig(
          `${big.length === 1 ? '1 file is' : `${big.length} files are`} over ${mb(FILE_MAX_BYTES)}: ${big
            .slice(0, 3)
            .map((f) => f.file.name)
            .join(', ')}${big.length > 3 ? ', …' : ''}.`
        )
      const bigNames = takesNames ? sorted.names.filter((f) => f.size > NAMES_MAX_BYTES) : []
      if (bigNames.length)
        setTooBig(
          `${PROGRAM_NAMES_FOLDER}/${bigNames[0]!.name} is over ${mb(NAMES_MAX_BYTES)}: a program names file is read in memory, up to ${mb(NAMES_MAX_BYTES)}.`
        )
      setFiles(sorted.files)
      setNames(sorted.names)
      setMappings(sorted.mappings)
      setReceipts(sorted.receipts)
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
          Choose a .zip file matching the structure and folders of the sample (zip) above.
        </p>
      )}
      <Field
        label="The month's zip, in the sample's folders"
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
                <div
                  key={name}
                  className={`ad-tile ${n ? 'ad-tile-ok' : OPTIONAL_FOLDERS.has(name) ? '' : 'ad-tile-warn'}`}
                >
                  <span className="ad-tile-label">{name}</span>
                  <span className="ad-tile-value">{n}</span>
                  <span className="ad-tile-note">{n === 1 ? 'file' : 'files'}</span>
                </div>
              )
            })}
            {names.length > 0 && takesNames && (
              <div className="ad-tile ad-tile-ok">
                <span className="ad-tile-label">{PROGRAM_NAMES_FOLDER}</span>
                <span className="ad-tile-value">{names.length}</span>
                <span className="ad-tile-note">{names.length === 1 ? 'file' : 'files'}</span>
              </div>
            )}
            {mappings.length > 0 && takesNames && (
              <div className="ad-tile ad-tile-ok">
                <span className="ad-tile-label">{ACCOUNT_MAPPING_FOLDER}</span>
                <span className="ad-tile-value">{mappings.length}</span>
                <span className="ad-tile-note">{mappings.length === 1 ? 'file' : 'files'}</span>
              </div>
            )}
            {receipts.length > 0 && takesReceipts && (
              <div className="ad-tile ad-tile-ok">
                <span className="ad-tile-label">{RECEIPTS_FOLDER}</span>
                <span className="ad-tile-value">{receipts.length}</span>
                <span className="ad-tile-note">{receipts.length === 1 ? 'file' : 'files'}</span>
              </div>
            )}
          </div>
          {(takesNames || takesReceipts) &&
            (() => {
              const big = oversizeExpenseFiles(
                takesNames ? mappings : [],
                takesReceipts ? receipts : []
              )
              return big ? (
                <Notice tone="warn">
                  Too large to read, left out (the payroll files still go up): {big.join(', ')}.
                </Notice>
              ) : null
            })()}
          {!takesNames &&
            (() => {
              // The workspace's own folders: only an owner reads them (Month End Close), so here they are left out.
              const left = (
                [
                  [PROGRAM_NAMES_FOLDER, names.length],
                  [ACCOUNT_MAPPING_FOLDER, mappings.length],
                  [RECEIPTS_FOLDER, takesReceipts ? 0 : receipts.length],
                ] as const
              ).filter(([, n]) => n > 0)
              if (!left.length) return null
              const n = left.reduce((sum, [, k]) => sum + k, 0)
              return (
                <Notice tone="warn">
                  Left out here: {andList(left.map(([name]) => name))} ({n}{' '}
                  {n === 1 ? 'file' : 'files'}). An owner adds {left.length === 1 ? 'it' : 'them'}{' '}
                  on Month End Close.
                </Notice>
              )
            })()}
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
              Matching uses only this zip
              {workspaceFiles > 0 &&
                ` and the ${workspaceFiles} workspace ${workspaceFiles === 1 ? 'file' : 'files'} from Month End Close, which stay`}
              . The earlier files are removed, with their matches, when you save at the end; nothing
              changes if you close before then.
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
            {`Or re-run matching with the ${existing} saved ${existing === 1 ? 'file' : 'files'}`}
          </Button>
        )}
        <Button
          kind={kind}
          onClick={() =>
            onReady(
              files,
              replace,
              takesNames ? names : [],
              takesNames ? mappings : [],
              takesReceipts ? receipts : []
            )
          }
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
