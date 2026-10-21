import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  MAX_WORKSPACE_PAYROLL_FILES,
  PAYROLL_SLOT_KIND,
  REPORT_LINE_LABELS,
  REPORT_STATUS_LABELS,
  type PayLineDto,
  type PayLineKind,
  type PayrollCandidate,
  type PayrollMatchProgress,
  type EngagementPayrollCardDto,
  type PayrollReconciliationDto,
  type PayrollSlot,
  type ReportLine,
  type StaffListDto,
  type StubPayDto,
  type TagType,
  type StatementMark,
  type WorkspaceDetail,
  type WorkspacePayrollFileDto,
  type WorkspacePayrollFilesDto,
  type WorkspacePayrollItemDto,
  type WorkspacePayrollMonthDto,
  type WorkspacePayrollPeriodDto,
  type WorkspacePayrollRunDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import { money, periodLabel } from '@/lib/format'
import { HandCard } from '@/components/HandCard'
import { AddParticipantModal } from '@/components/AddParticipantModal'
import { AddStaffFoundModal } from '@/pages/WorkspacePayrollAddStaff'
import {
  AiReadBox,
  AiReadingNote,
  useAiAfterUpload,
  usePayrollAi,
} from '@/components/payroll-match/AiReadBox'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { UploadPanel } from '@/components/PayrollProof'
import {
  BudgetTracking,
  FileStats,
  PayrollActions,
  ResolveGrid,
  colorsOf,
  useCards,
  type ResolveKind,
} from '@/pages/WorkspacePayrollSummary'
import { PayrollFilesCard, type PayrollUpload } from '@/pages/WorkspacePayrollFiles'
import {
  ParticipantsFound,
  PlanWords,
  StaffFound,
  type ShowSpot,
} from '@/pages/WorkspacePayrollReview'
import {
  LineCapNotes,
  MatchFooter,
  ProofFoot,
  ProvedCount,
  RemainingSection,
  MatchedBy,
  UnsavedNote,
  WhyPanel,
} from '@/components/payroll-match/MatchParts'
import { SLOT_LABEL } from '@/components/payroll-match/why'
import {
  isStaffLine,
  itemBlocks,
  missingAfterSave,
  nobodyBlock,
  ownChoice,
  paidWords,
  participantBlocks,
  proofList,
  provedRows,
  slotSource,
  staffBlocks,
  staffMissingWhy,
} from '@/pages/workspace-payroll-plan'
import {
  autoPick,
  distinctFileCount,
  keyOf,
  lacksLine,
  ownLinks,
  slotKey,
  type Picks,
} from '@/pages/workspace-payroll'
import '@/components/match-pairs.css'
import {
  Button,
  Card,
  Chip,
  Empty,
  ErrorNote,
  Field,
  Modal,
  Notice,
  Stepper,
  inputClass,
} from '@/components/ui'

/** pdf.js is large: it loads when a copy is first shown. */
const StatementViewer = lazy(() =>
  import('@/components/StatementViewer').then((m) => ({ default: m.StatementViewer }))
)

/** The proof each person-pay is, on an item: a register its register, a pay stub a participant's pay, a bank line a staff line's. */
const PAY_SLOT: Record<PayLineKind, PayrollSlot> = {
  'payroll-register': 'register',
  paystub: 'stub',
  'bank-statement': 'bank',
}
/** The item's second line: a staff line's report line in words, a participant's id. */
const subOf = (i: WorkspacePayrollItemDto) =>
  i.kind === 'staff' ? (REPORT_LINE_LABELS[i.sub as ReportLine] ?? i.sub) : i.sub
const many = (n: number, one: string, more = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : more}`
/** Files go up to the run 20 at a time, the server's limit for one request. */
const BATCH = 20
/** The progress poll gives up after this long with no file read. */
const STALL_MS = 10 * 60_000
const STALLED = 'No file was read in 10 minutes.'
const GONE = 'This upload is no longer here: it was discarded, or left for over a day.'
const isWaiting = (r: WorkspacePayrollRunDto) =>
  r.files.some((f) => f.status === 'waiting' || f.status === 'reading')

/**
 * "Match payroll & timecards" for the whole workspace and a month (GitHub issue #22), and its reconciliation: every
 * person-pay found in the files and where it landed, and each engagement's payroll item still missing proof. Each month
 * has one set of payroll files (owner's decision, 2026-10-18). Owners change the set and fix the reconciliation;
 * auditors read it.
 */
export function WorkspacePayrollPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { data: w, error: wError, status: wStatus } = useLoad<WorkspaceDetail>(`/workspaces/${id}`)
  const {
    data: periods,
    error,
    status,
  } = useLoad<WorkspacePayrollPeriodDto[]>(`/workspaces/${id}/payroll`)
  const period = params.get('period') ?? periods?.[0]?.period ?? null
  const recon = useLoad<PayrollReconciliationDto>(
    period ? `/workspaces/${id}/payroll/${period}/reconciliation` : null
  )
  // Owners and auditors only: to anyone else (a bookkeeper who types the address) the page is not there.
  const reader = w?.myRole === 'owner' || w?.myRole === 'auditor'
  const files = useLoad<WorkspacePayrollFilesDto>(
    period && reader ? `/workspaces/${id}/payroll/${period}/files` : null
  )
  // The staff list's engagements give each engagement card its colour, as on the staffing page.
  const staffList = useLoad<StaffListDto>(reader ? `/workspaces/${id}/staff` : null)
  /** Changes on each save and each reconciliation change, so the engagement cards are read again. */
  const [cardsVersion, setCardsVersion] = useState(0)
  /** The match on its own: opened from Actions, or a match started from the files card. */
  const [focus, setFocus] = useState(false)
  const [matchStep, setMatchStep] = useState<'Upload' | 'Match'>('Upload')
  /** Starts the match card afresh when the owner goes back to the summary. */
  const [matchKey, setMatchKey] = useState(0)
  /** What Save did, said once over the summary it returns to. */
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [resolve, setResolve] = useState<ResolveKind | null>(null)
  // Another month starts afresh: no note, filter or "saved just now" carried over from the last one.
  const [shownPeriod, setShownPeriod] = useState(period)
  if (shownPeriod !== period) {
    setShownPeriod(period)
    setCardsVersion(0)
    setSavedNote(null)
    setResolve(null)
    setFocus(false)
  }
  const d = useCards(id, period ?? '', period ? cardsVersion : 0, !!period)
  if (wStatus === 404 || status === 404 || (w && !reader)) return <NotFoundPage />
  if (wError || error) return <ErrorNote message={wError ?? error} />
  if (!w || !periods) return <Empty>Loading…</Empty>
  const owner = w.myRole === 'owner'
  const shownRecon = recon.data?.period === period ? recon.data : null
  const shownFiles = files.data?.period === period ? files.data : null
  // The month has payroll files (or one was saved just now): the engagement cards show.
  const saved = !!shownFiles?.files.length || !!shownRecon?.pays.length || cardsVersion > 0
  const filesError = files.loading ? null : files.error
  return (
    <>
      <nav className="ad-crumbs" aria-label="Breadcrumb">
        <Link to="/workspaces">Workspace Manager</Link> /{' '}
        <Link to={`/workspaces/${w.id}`}>{w.name}</Link> / Month End Payroll Processing
      </nav>
      <div className="ad-head">
        <div>
          <p className="ad-eyebrow">Workspace</p>
          <h1 className="ad-h1">Month End Payroll Processing</h1>
          <p className="ad-sub">
            One set of payroll files for the month, matched to every engagement&apos;s payroll
            items, existing staff and engagement participants.
          </p>
        </div>
        {periods.length > 0 && (
          <label className="ad-field max-w-xs">
            <span>Month</span>
            <select
              className={inputClass}
              value={period ?? ''}
              onChange={(e) => setParams({ period: e.target.value })}
            >
              {periods.map((p) => (
                <option key={p.period} value={p.period}>
                  {periodLabel(p.period)} · {p.months}{' '}
                  {p.months === 1 ? 'engagement' : 'engagements'}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!period ? (
        <Empty>No engagement has a month yet. Start one on an engagement&apos;s page first.</Empty>
      ) : (
        // minmax(0, 1fr): the column is the page's width, never the widest thing in it, so the page never scrolls sideways.
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          {!focus && savedNote && (
            <div style={{ order: 0 }}>
              <Notice tone="ok" fade>
                {savedNote}
              </Notice>
            </div>
          )}
          {!focus && (
            <div style={{ order: 1 }}>
              <PayrollActions
                period={period}
                matched={saved}
                cards={d.cards}
                recon={shownRecon}
                colors={colorsOf(
                  (staffList.data?.engagements ?? []).map((e) => e.id),
                  (d.cards ?? []).map((c) => c.engagementId)
                )}
                onMatch={
                  owner
                    ? () => {
                        setFocus(true)
                        window.scrollTo({ top: 0 })
                      }
                    : undefined
                }
                onShow={(k) => {
                  setResolve(k)
                  document.getElementById('wpd-grid')?.scrollIntoView({ behavior: 'smooth' })
                }}
              />
            </div>
          )}
          {!focus && (
            <div style={{ order: 3 }}>
              <BudgetTracking
                period={period}
                cards={d.cards}
                error={d.error}
                colors={colorsOf(
                  (staffList.data?.engagements ?? []).map((e) => e.id),
                  (d.cards ?? []).map((c) => c.engagementId)
                )}
              />
            </div>
          )}
          {saved && !focus && (
            <div style={{ order: 4 }}>
              <Reconciliation
                key={`rd-${period}`}
                workspaceId={w.id}
                period={period}
                data={shownRecon}
                error={recon.loading ? null : recon.error}
                onChange={(r) => {
                  recon.setData(r)
                  setCardsVersion((n) => n + 1)
                }}
                d={{
                  filter: resolve,
                  onFilter: setResolve,
                  cards: d.cards,
                  files: shownFiles,
                  colors: colorsOf(
                    (staffList.data?.engagements ?? []).map((e) => e.id),
                    (d.cards ?? []).map((c) => c.engagementId)
                  ),
                }}
              />
            </div>
          )}
          {owner ? (
            // The match card is last once the month is matched, and opened from Actions before.
            <div style={{ order: saved && !focus ? 9 : 2 }} hidden={!saved && !focus}>
              {focus && matchStep !== 'Match' && (
                <button
                  type="button"
                  className="wpd-back"
                  onClick={() => {
                    setFocus(false)
                    setMatchKey((n) => n + 1)
                  }}
                >
                  ← Back to {periodLabel(period)}&apos;s summary
                </button>
              )}
              <WorkspaceMatch
                key={`${period}-${matchKey}`}
                compact={saved && !focus}
                alone={focus}
                fileStats={<FileStats files={shownFiles} data={shownRecon} />}
                onOpen={() => {
                  setFocus(true)
                  window.scrollTo({ top: 0 })
                }}
                onStep={(st) => {
                  setMatchStep(st)
                  if (st !== 'Upload') setFocus(true)
                }}
                workspaceId={w.id}
                period={period}
                files={shownFiles}
                filesError={filesError}
                staff={staffList.data}
                tagTypes={w.tagTypes}
                onStaffChanged={staffList.setData}
                onSaved={(r) => {
                  recon.setData(r)
                  setCardsVersion((n) => n + 1)
                  void files.reload()
                  // Save goes back to the month's summary, where the results are, not a Done step.
                  setFocus(false)
                  setMatchKey((n) => n + 1)
                  setSavedNote(`Saved the payroll for ${periodLabel(period)}.`)
                  window.scrollTo({ top: 0 })
                }}
              />
            </div>
          ) : (
            <PayrollFilesCard period={period} files={shownFiles} error={filesError} />
          )}
        </div>
      )}
    </>
  )
}

/**
 * The month's payroll files and the change to them: Replace all, Add files, Remove a file or Match again, each a run
 * that is read, checked and saved. Owners only.
 */
function WorkspaceMatch({
  workspaceId,
  period,
  files,
  filesError,
  staff,
  tagTypes,
  onStaffChanged,
  onSaved,
  compact = false,
  onStep,
  onOpen,
  fileStats,
  alone = false,
}: {
  workspaceId: string
  period: string
  /** The month's set, once loaded. */
  files: WorkspacePayrollFilesDto | null
  filesError: string | null
  /** The staff list, for adding someone the files name from the match screen. */
  staff: StaffListDto | null
  tagTypes: TagType[]
  onStaffChanged: (list: StaffListDto) => void
  onSaved: (r: PayrollReconciliationDto) => void
  /** With the month matched, one small card at the page's end until a match is started. */
  compact?: boolean
  /** The page shows the match on its own while it runs. */
  onStep?: (step: 'Upload' | 'Match') => void
  /** Match again on the files card opens the match on its own. */
  onOpen?: () => void
  /** What the files hold, one short line on the File Management card. */
  fileStats?: React.ReactNode
  /** The match open on its own, with nothing else on the page (no files card above it). */
  alone?: boolean
}) {
  const STEPS = ['Upload', 'Match'] as const
  const [step, setStep] = useState<'Upload' | 'Match'>('Upload')
  useEffect(() => onStep?.(step), [step, onStep])
  /** "Read the files with AI", ticked on the Upload step: unticked each time the page opens (#22). */
  const [withAi, setWithAi] = useState(false)
  const payrollAi = usePayrollAi()
  const [run, setRun] = useState<WorkspacePayrollRunDto | null>(null)
  const [progress, setProgress] = useState<PayrollMatchProgress | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  /** A refusal of a change started from the files card, shown there. */
  const [fileError, setFileError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** The upload can't go on as it is (half sent, gone, a file removed): the screen offers Start again. */
  const [stuck, setStuck] = useState(false)
  const [picks, setPicks] = useState<Picks>({})
  /** Guesses the owner confirmed (`slotKey`): sent with Save, as the owner's own decisions. */
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [reopening, setReopening] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  /** Someone the files name who is on no list, being added from the match screen. */
  const [addingStaff, setAddingStaff] = useState<string | null>(null)
  const [addingStub, setAddingStub] = useState<StubPayDto | null>(null)
  /** What the last add from the match screen did. */
  const [addedNote, setAddedNote] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{
    title: string
    src: string
    page: number
    personal: boolean
    /** The file's own name, for Download. */
    fileName?: string
    /** The line found, highlighted on the file (a staff member's or a participant's proof). */
    mark?: StatementMark | null
  } | null>(null)
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api

  // An unsaved run of the month picks up where it was (the job keeps reading while the page is closed).
  useEffect(() => {
    let gone = false
    void apiRef.current
      .get<WorkspacePayrollRunDto | null>(`/workspaces/${workspaceId}/payroll/${period}/match`)
      .then((open) => {
        if (gone || !open) return
        setRun(open)
        setStep('Match')
      })
      .catch((e: Error) => !gone && setRunError(e.message))
    return () => {
      gone = true
    }
  }, [workspaceId, period])

  const runId = run?.id
  const waiting = !pollError && !!run && isWaiting(run)
  // Once the server has read the files, AI reads them when ticked, then the match is shown.
  const ai = useAiAfterUpload({
    run,
    ready: !!run && !waiting && !pollError,
    on: withAi,
    read: (id, fileIds) =>
      api.post<WorkspacePayrollRunDto>(`/workspace-payroll-match/${id}/ai-read`, { fileIds }),
    onRun: setRun,
  })
  const aiBox = payrollAi && (
    <AiReadBox
      available={payrollAi.available}
      beta={payrollAi.beta}
      checked={withAi}
      onChange={setWithAi}
    />
  )
  useEffect(() => {
    if (!runId || !waiting) return
    let gone = false
    void (async () => {
      let failures = 0
      let last = -1
      let movedAt = Date.now()
      while (!gone) {
        await new Promise((ok) => setTimeout(ok, 1500))
        if (gone) return
        if (Date.now() - movedAt > STALL_MS) return setPollError(STALLED)
        try {
          const p = await apiRef.current.get<PayrollMatchProgress>(
            `/workspace-payroll-match/${runId}/progress`
          )
          if (gone) return
          if (p.read + p.failed !== last) {
            last = p.read + p.failed
            movedAt = Date.now()
          }
          setProgress(p)
          if (p.read + p.failed >= p.total) {
            // The final read of the run counts toward the stop like any other: a failure here is not a success.
            const all = await apiRef.current.get<WorkspacePayrollRunDto>(
              `/workspace-payroll-match/${runId}`
            )
            if (gone) return
            setRun(all)
            // A file still waiting after all (the count ran ahead of the run): keep polling, never freeze on "N of N".
            if (!isWaiting(all)) return
          }
          failures = 0
        } catch (e) {
          if (gone) return
          const refused = e instanceof ApiError && e.status >= 400 && e.status < 500
          if (e instanceof ApiError && e.status === 404) return setPollError(GONE)
          if (refused || ++failures >= 5) return setPollError((e as Error).message)
        }
      }
    })()
    return () => {
      gone = true
    }
  }, [runId, waiting])

  /** Removes a run on the server; one already gone counts as removed. */
  const remove = async (runId: string) => {
    try {
      await api.del(`/workspace-payroll-match/${runId}`)
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e
    }
  }

  /** A new run is on screen: its matches start from Auto-Match's picks. */
  const opened = (r: WorkspacePayrollRunDto) => {
    setRun(r)
    setPicks({})
    setConfirmed(new Set())
    setStep('Match')
  }
  const clearErrors = () => {
    setRunError(null)
    setFileError(null)
    setPollError(null)
    setSaveError(null)
    setStuck(false)
    setProgress(null)
  }

  /**
   * Replace all (a zip: it becomes the month's set) or Add files. Replace all tells the server how many different files
   * the zip holds, so Save waits until all of them are there. An upload of the same change that stopped halfway carries
   * on: the server answers it as it stands and skips each file it already has.
   */
  const upload = async (
    mode: 'replace' | 'add',
    list: PayrollUpload,
    where: 'files' | 'match'
  ): Promise<boolean> => {
    clearErrors()
    const fail = where === 'files' ? setFileError : setRunError
    try {
      let expected: number | undefined
      if (mode === 'replace') {
        setBusy('Counting the files…')
        expected = await distinctFileCount(list.map((f) => f.file))
      }
      setBusy('Starting…')
      // A finished Replace all on screen is set aside for the new zip.
      if (run && mode === 'replace' && run.mode === 'replace' && run.plan.complete) {
        await remove(run.id)
        setRun(null)
      }
      let current = await api.post<WorkspacePayrollRunDto>(
        `/workspaces/${workspaceId}/payroll/${period}/match`,
        mode === 'replace' ? { mode, expected } : { mode }
      )
      for (let at = 0; at < list.length; at += BATCH) {
        const batch = list.slice(at, at + BATCH)
        setBusy(`Sending files ${at + 1}–${at + batch.length} of ${list.length}…`)
        const form = new FormData()
        for (const f of batch) {
          form.append('files', f.file)
          form.append('kinds', f.kind)
        }
        current = await api.upload<WorkspacePayrollRunDto>(
          `/workspace-payroll-match/${current.id}/files`,
          form
        )
      }
      opened(current)
      return true
    } catch (e) {
      // The server may hold a half-sent upload: sending the same zip again carries on, Start again removes it.
      fail((e as Error).message)
      setStuck(true)
      return false
    } finally {
      setBusy(null)
    }
  }

  /** Remove a file: a run that takes it out of the set, matched again from the rest, to check and save. */
  const removeFile = async (f: WorkspacePayrollFileDto): Promise<boolean> => {
    clearErrors()
    setBusy(`Removing ${f.fileName}…`)
    try {
      opened(
        await api.post<WorkspacePayrollRunDto>(
          `/workspaces/${workspaceId}/payroll/${period}/files/${f.id}/remove`
        )
      )
      return true
    } catch (e) {
      setFileError((e as Error).message)
      return false
    } finally {
      setBusy(null)
    }
  }

  /**
   * Match again: the month's set as it is, matched anew (a participant or a staff member's engagement was added since).
   * It goes on like an upload: read, check, save.
   */
  const matchAgain = async () => {
    clearErrors()
    setBusy('Matching again…')
    try {
      if (run) await remove(run.id)
      setRun(null)
      opened(
        await api.post<WorkspacePayrollRunDto>(
          `/workspaces/${workspaceId}/payroll/${period}/match-again`
        )
      )
    } catch (e) {
      setRunError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const hasFiles = !!files?.files.length
  const againAction = hasFiles && (
    <div className="ad-actions justify-start">
      <Button kind="navy" disabled={!!busy} onClick={() => void matchAgain()}>
        {busy === 'Matching again…' ? busy : 'Match again'}
      </Button>
      <span className="text-sm text-soft">
        Matches the month&apos;s files again, after a participant or a staff tag was added.
      </span>
    </div>
  )

  /** Back to the start with nothing open: the change on screen, or any the server holds for the month, goes. */
  const startAgain = async () => {
    setBusy('Starting again…')
    try {
      const open =
        run ??
        (await api.get<WorkspacePayrollRunDto | null>(
          `/workspaces/${workspaceId}/payroll/${period}/match`
        ))
      if (open) await remove(open.id)
      clearErrors()
    } catch (e) {
      setRunError((e as Error).message)
      setStuck(true)
    } finally {
      setBusy(null)
    }
    setRun(null)
    setProgress(null)
    setPollError(null)
    setPicks({})
    setConfirmed(new Set())
    setStep('Upload')
  }

  const discard = async () => {
    if (!run) return
    try {
      await remove(run.id)
    } catch (e) {
      return setRunError((e as Error).message)
    }
    setRun(null)
    setPicks({})
    setConfirmed(new Set())
    setSaveError(null)
    setStep('Upload')
  }

  const items = run?.items ?? []
  // What the plan attaches decides what is still open; the owner's own choices don't move a row off the table.
  const planned = run ? proofList(run, []) : []
  const open = items.filter((i) => missingAfterSave(i, planned).length > 0)
  const pick = (i: WorkspacePayrollItemDto, slot: PayrollSlot) =>
    picks[keyOf(i)]?.[slot] ?? (run ? autoPick(run, i, slot).pick : null) ?? ''
  const candidate = (
    i: WorkspacePayrollItemDto,
    slot: PayrollSlot,
    fileId: string
  ): PayrollCandidate | undefined =>
    run?.slots
      .find((m) => m.target === i.target && m.id === i.id && m.slot === slot)
      ?.candidates.find((c) => c.fileId === fileId)
  const noLine = (i: WorkspacePayrollItemDto, slot: PayrollSlot, fileId: string) =>
    !!run && lacksLine(run, i, slot, fileId)
  // Only the owner's own decisions go with Save; the server links Auto-Match's sure picks itself.
  const toSave = run ? ownLinks(run, picks, confirmed) : []
  const proof = run ? proofList(run, toSave) : []
  const touched = new Set(
    toSave.map((l) => items.find((i) => i.target === l.target && i.id === l.id)!.reportId)
  )
  // The months the owner's choices change, and those the plan's own work changes.
  const toReopen: WorkspacePayrollMonthDto[] = [
    ...(run?.months ?? []).filter((m) => touched.has(m.reportId) && m.status !== 'draft'),
    ...(run?.plan.reopen ?? []),
  ].filter((m, i, all) => all.findIndex((x) => x.reportId === m.reportId) === i)

  const save = async (why?: string) => {
    if (!run) return
    setSaving(true)
    setSaveError(null)
    try {
      const out = await api.post<PayrollReconciliationDto>(
        `/workspace-payroll-match/${run.id}/save`,
        {
          links: toSave,
          ...(why ? { reopenReason: why } : {}),
        }
      )
      setReopening(false)
      setRun(null)
      setPicks({})
      setConfirmed(new Set())
      // Save goes back to the month's summary, which shows what it did.
      onSaved(out)
    } catch (e) {
      setSaveError((e as Error).message)
      // A file of the upload was removed, or the set changed meanwhile: it can't be saved as it is.
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        setStuck(true)
        setReopening(false)
      }
    } finally {
      setSaving(false)
    }
  }

  // A file the job could not read (scanned, password-protected, broken) may still be the proof, checked by eye.
  const unread = (fileId: string) => run?.files.find((f) => f.id === fileId)?.status === 'failed'
  const againButton = (
    <div className="ad-actions justify-start">
      <Button kind="navy" disabled={!!busy} onClick={() => void startAgain()}>
        Start again
      </Button>
    </div>
  )

  const cell = (i: WorkspacePayrollItemDto, slot: PayrollSlot) => {
    const from = slotSource(i, slot, planned)
    if (from?.on === 'file')
      return (
        <Chip tone="ok" fill>
          ✓ on file
        </Chip>
      )
    if (from)
      return (
        <Chip tone="ok" fill>
          {from.people.length
            ? `✓ From ${i.kind === 'staff' ? 'staff' : 'the files'}: ${from.people.join(', ')}`
            : '✓ ⚡ Found'}
        </Chip>
      )
    if (!run) return <Chip tone="warn">missing</Chip>
    // A staff line's proof comes from the staff tagged to its engagement, never a file chosen here.
    if (isStaffLine(i))
      return <small className="ad-match-note-missing">✕ {staffMissingWhy(run, i, slot)}</small>
    const options = run.files.filter((f) => f.kind === PAYROLL_SLOT_KIND[slot])
    const value = pick(i, slot)
    const manual = picks[keyOf(i)]?.[slot]
    const auto = autoPick(run, i, slot)
    const isAuto = manual === undefined && !!value
    const c = value ? candidate(i, slot, value) : undefined
    const isConfirmed = confirmed.has(slotKey(i, slot))
    const state = !value
      ? 'missing'
      : noLine(i, slot, value)
        ? 'guess'
        : isAuto && !auto.sure && !isConfirmed
          ? 'guess'
          : 'ok'
    const marks = c?.marks.length ? c.marks : c?.mark ? [c.mark] : []
    return (
      <>
        <select
          className={`${inputClass} ad-match-${state}`}
          aria-label={`${SLOT_LABEL[slot]} for ${i.title}`}
          value={value}
          onChange={(e) =>
            setPicks((p) => ({ ...p, [keyOf(i)]: { ...p[keyOf(i)], [slot]: e.target.value } }))
          }
        >
          <option value="">{options.length ? 'Choose…' : 'None uploaded'}</option>
          {options.map((f) => (
            <option key={f.id} value={f.id}>
              {f.fileName}
              {f.status === 'failed'
                ? ' (no text found, check it by eye)'
                : f.scanned
                  ? ' (scanned)'
                  : ''}
            </option>
          ))}
        </select>
        <ProofFoot
          state={state}
          text={
            state === 'missing'
              ? undefined
              : value && noLine(i, slot, value)
                ? '⚠️ No line found: link it from the reconciliation'
                : state === 'guess'
                  ? '⚠️ ⚡ Best guess: check it'
                  : unread(value)
                    ? '✓ Chosen: no text found, check it by eye'
                    : `✓ ${isAuto ? (isConfirmed ? 'Confirmed' : `⚡ Found${c?.mark ? `, page ${c.mark.page}` : ''}`) : 'Chosen'}`
          }
          onShow={
            value && marks.length > 0
              ? () =>
                  setViewing({
                    title: `${i.title}: ${SLOT_LABEL[slot].toLowerCase()}`,
                    src: `/workspace-payroll-match/${run.id}/files/${value}/copy?target=${i.target}&id=${i.id}&slot=${slot}`,
                    page: marks[0]!.page,
                    personal: slot === 'stub',
                    fileName: run.files.find((f) => f.id === value)?.fileName,
                  })
              : undefined
          }
        >
          {state === 'guess' && !(value && noLine(i, slot, value)) && (
            <button
              type="button"
              className="ad-match-show"
              onClick={() => setConfirmed((s) => new Set(s).add(slotKey(i, slot)))}
            >
              Confirm
            </button>
          )}
        </ProofFoot>
      </>
    )
  }

  /** Show on Staff and Participants: the run's file itself, with the line found highlighted. */
  const showSpot: ShowSpot = (spot, title, slot) => {
    if (!run) return
    setViewing({
      title,
      src: `/workspace-payroll-match/${run.id}/files/${spot.fileId}`,
      page: spot.mark?.page ?? 1,
      personal: slot === 'stub',
      fileName: run.files.find((f) => f.id === spot.fileId)?.fileName,
      mark: spot.mark,
    })
  }

  const shown = progress ?? {
    total: run?.files.length ?? 0,
    read: run?.files.filter((f) => f.status === 'read').length ?? 0,
    failed: run?.files.filter((f) => f.status === 'failed').length ?? 0,
  }
  const uploadMode = run?.mode === 'replace' || run?.mode === 'add'
  // Replace all: Save waits until every file of the zip has arrived.
  const incomplete = !!run && !run.plan.complete
  // Fully proved once Save attaches the plan's proof, and "How Auto-Match decided", as on the bookkeeper's wizard.
  const proved = run ? provedRows(run, planned) : []
  const choice = (i: WorkspacePayrollItemDto, slot: PayrollSlot) =>
    run ? ownChoice(run, picks, confirmed, i, slot) : undefined
  const nobody = run ? nobodyBlock(run, toSave) : null
  const blocks = run
    ? [
        ...staffBlocks(run),
        ...participantBlocks(run, planned, choice),
        ...itemBlocks(run, open, planned, choice),
        ...(nobody ? [nobody] : []),
      ]
    : []

  /** How the upload works, with the sample zip: on the first upload and on the match opened on its own. */
  const howTo = (
    <HandCard
      title="One upload covering every engagement"
      icon="🧾"
      lead="Upload the month's payroll once: we match it to each engagement's payroll items."
    >
      <ol className="ad-hand-steps">
        <li>
          Upload the company&apos;s payroll zip for {periodLabel(period)}, in the sample&apos;s five
          folders.
        </li>
        <li>Check what Auto-Match found for each engagement, and save.</li>
        <li>
          The reconciliation below shows what was matched, anything that isn&apos;t, and items
          needing adjustment.
        </li>
      </ol>
      <p className="ad-hand-address">
        <span className="ad-hand-address-label">The zip&apos;s layout</span>
        <span>
          Timesheets · Payroll registers · Pay stubs · Bank statements · Payroll details (when you
          have it)
        </span>
        <a href="/samples/payroll-workspace-sample.zip" download>
          Download a sample (zip)
        </a>
      </p>
    </HandCard>
  )

  // The files, last on the page, with Match again first: after a list changes, matching the
  // same files again is the fix, not changing them. Match again opens the match on its own, where its AI choice is.
  if (compact && step === 'Upload' && hasFiles && !run)
    return (
      <PayrollFilesCard
        period={period}
        files={files}
        error={filesError}
        title={`File Management (${files!.files.length} saved)`}
        note={
          <>
            <ErrorNote message={runError} />
            {fileStats}
            <p className="text-sm">
              <b>Added a participant or tagged staff since?</b> Match again: it reads these same
              files with the lists as they are now. Replace or add files only when one is wrong or
              missing.
            </p>
          </>
        }
        first={
          <Button kind="navy" size="sm" disabled={!!busy} onClick={onOpen}>
            Match again
          </Button>
        }
        actions={{
          busy,
          error: fileError,
          changeOpen: !!run,
          onReplace: (zip) => upload('replace', zip, 'files'),
          onAdd: (added) => upload('add', added, 'files'),
          onRemove: removeFile,
        }}
      />
    )

  return (
    <>
      {(hasFiles || !files) && !alone && (
        <PayrollFilesCard
          period={period}
          files={files}
          error={filesError}
          actions={{
            busy,
            error: fileError,
            changeOpen: !!run,
            onReplace: (zip) => upload('replace', zip, 'files'),
            onAdd: (added) => upload('add', added, 'files'),
            onRemove: removeFile,
          }}
        />
      )}
      <Card
        title={`Match payroll & timecards: ${periodLabel(period)}`}
        aside={
          step === 'Match' &&
          run &&
          !waiting &&
          !pollError &&
          !ai.reading && <ProvedCount proved={proved.length} total={proved.length + open.length} />
        }
      >
        <Stepper steps={STEPS} current={step} />
        <ErrorNote message={runError} />
        {(runError || fileError) && stuck && againButton}
        {step === 'Upload' && !hasFiles && (
          <div className="grid gap-4">
            {howTo}
            {aiBox}
            <UploadPanel
              existing={0}
              busy={busy}
              maxFiles={MAX_WORKSPACE_PAYROLL_FILES}
              kind="navy"
              onReady={(zip) => void upload('replace', zip, 'match')}
            />
          </div>
        )}
        {step === 'Upload' && hasFiles && (
          <div className="grid gap-4">
            {alone && howTo}
            {alone ? (
              <p className="text-sm">
                <b>
                  Upload the month&apos;s zip, or match the {files!.files.length} saved files again.
                </b>{' '}
                Nothing is saved until you check the result and press Save.
              </p>
            ) : (
              <p className="text-sm">
                <b>Change the files above, or match them again.</b> Each change is checked here
                before it is saved.
              </p>
            )}
            {aiBox}
            {alone ? (
              // As the bookkeeper's wizard (the two match screens stay alike): a zip to add or to replace the saved
              // files with, or Skip to match the saved files again.
              <UploadPanel
                existing={files!.files.length}
                busy={busy}
                maxFiles={MAX_WORKSPACE_PAYROLL_FILES}
                kind="navy"
                onReady={(zip, replace) => void upload(replace ? 'replace' : 'add', zip, 'match')}
                onSkip={() => void matchAgain()}
              />
            ) : (
              againAction
            )}
          </div>
        )}

        {step === 'Match' && run && waiting && (
          <div className="grid gap-4">
            <p className="text-sm font-semibold" role="status">
              <span className="ad-hourglass" aria-hidden="true">
                ⏳
              </span>{' '}
              Reading the files on the server: {shown.read} of {shown.total} done
              {shown.failed ? `, ${shown.failed} could not be read` : ''}
            </p>
            <HandCard
              title="Reading your files"
              icon="⏳"
              lead="You can close this: it keeps reading."
            >
              <p>When you open this page again, you pick up here.</p>
            </HandCard>
          </div>
        )}
        {step === 'Match' && run && pollError && (
          <>
            <ErrorNote message={pollError} />
            {againButton}
          </>
        )}
        {step === 'Match' && run && !waiting && !pollError && ai.reading && (
          <AiReadingNote progress={ai.progress} error={null} />
        )}
        {step === 'Match' && run && !waiting && !pollError && !ai.reading && (
          <div className="grid gap-4">
            <UnsavedNote what={uploadMode ? 'upload' : 'change'} />
            {ai.error && <AiReadingNote progress={null} error={ai.error} />}
            <LineCapNotes files={run.files.filter((f) => f.overLineCap)} />
            {items.length === 0 ? (
              // Nothing to fill on the months yet (no staff lines imported, no payments): what Save does is below.
              run.months.length === 0 && (
                <Empty>
                  No engagement has a month for {periodLabel(period)}: start one to file this
                  payroll.
                </Empty>
              )
            ) : open.length === 0 ? (
              <Empty>Every payroll item has its proof once you save.</Empty>
            ) : (
              <RemainingSection count={open.length}>
                <div className="ad-tablewrap">
                  <table className="ad-table">
                    <thead>
                      <tr>
                        <th>Engagement</th>
                        <th>Paid</th>
                        <th>Date</th>
                        <th className="ad-num">Amount</th>
                        <th>Timesheet</th>
                        <th>Payroll register</th>
                        <th>Evidence of payment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {open.map((i) => (
                        <tr key={keyOf(i)}>
                          <td>
                            <span className="font-semibold">{i.engagementName}</span>
                            <span className="ad-table-sub">
                              {REPORT_STATUS_LABELS[i.monthStatus]}
                            </span>
                          </td>
                          <td>
                            <span className="font-semibold">{i.title}</span>
                            <span className="ad-table-sub">{subOf(i)}</span>
                          </td>
                          <td className="whitespace-nowrap">{paidWords(i)}</td>
                          <td className="ad-num font-semibold">{money(i.amount)}</td>
                          <td className="ad-matchcell">{cell(i, 'timesheet')}</td>
                          <td className="ad-matchcell">{cell(i, 'register')}</td>
                          <td className="ad-matchcell">
                            {cell(i, i.kind === 'participant' ? 'stub' : 'bank')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </RemainingSection>
            )}
            {addedNote && (
              <Notice tone="ok" fade>
                {addedNote}
              </Notice>
            )}
            <StaffFound
              run={run}
              workspaceId={workspaceId}
              onShow={showSpot}
              onAdd={staff?.can.change ? (name) => setAddingStaff(name) : undefined}
            />
            <ParticipantsFound
              run={run}
              onShow={showSpot}
              onAdd={staff?.can.change ? (stub) => setAddingStub(stub) : undefined}
            />
            {addingStaff && staff && (
              <AddStaffFoundModal
                runId={run.id}
                name={addingStaff}
                list={staff}
                onClose={() => setAddingStaff(null)}
                onAdded={(r, list) => {
                  // The add answers the match worked out again from the files already read: nothing re-runs, and
                  // the owner's choices on the table stay.
                  onStaffChanged(list)
                  setRun(r)
                  setAddingStaff(null)
                  setAddedNote(`Added ${addingStaff} to staff.`)
                }}
              />
            )}
            {addingStub && staff && (
              <AddParticipantModal
                engagementId=""
                engagements={staff.engagements.filter((e) => e.status !== 'closed')}
                name={addingStub.named ?? ''}
                tagTypes={tagTypes}
                onClose={() => setAddingStub(null)}
                submit={async (engagementId, body) => {
                  setRun(
                    await api.post<WorkspacePayrollRunDto>(
                      `/workspace-payroll-match/${run.id}/participants`,
                      { engagementId, ...body }
                    )
                  )
                  setAddingStub(null)
                  setAddedNote(`Added ${body.displayName} as a participant.`)
                }}
                onAdded={() => setAddingStub(null)}
              />
            )}
            {!reopening && <ErrorNote message={saveError} />}
            {saveError && stuck && againButton}
            {blocks.length > 0 && (
              <WhyPanel
                blocks={blocks}
                source={<MatchedBy run={run} />}
                intro="Auto-Match opens every file in your zip and looks for each person's name, pay and pay period. Below, for every staff member, participant and item still to match, you see which file it picked for each proof and what it found there, or why it found nothing; last, the lines and files that land on no engagement. Show, on the grid, opens that file with those words highlighted."
              />
            )}
            {incomplete && (
              <div className="grid gap-3">
                <p className="ad-field-error-sum" role="status">
                  {run.files.length.toLocaleString('en-US')} of the zip&apos;s{' '}
                  {many(run.expectedFiles ?? 0, 'file')} have arrived. Choose the zip again to send
                  the rest.
                </p>
                <UploadPanel
                  existing={0}
                  busy={busy}
                  maxFiles={MAX_WORKSPACE_PAYROLL_FILES}
                  kind="navy"
                  action="Send the rest of the zip"
                  onReady={(zip) => void upload('replace', zip, 'match')}
                />
              </div>
            )}
            <PlanWords run={run} chosen={toSave} proof={proof} reopen={toReopen} />
            <MatchFooter
              onBack={() => setStep('Upload')}
              backLabel="Back: upload"
              onDiscard={() => void discard()}
              discardLabel={uploadMode ? 'Discard this upload' : 'Discard this change'}
              saving={saving}
              save={{
                label: saving ? 'Saving…' : 'Save and continue',
                disabled: saving || incomplete,
                onClick: () => (toReopen.length ? setReopening(true) : void save()),
              }}
            />
          </div>
        )}

        {reopening && (
          <Modal
            title="Reopen months to save"
            onClose={() => {
              setReopening(false)
              setSaveError(null)
            }}
          >
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                const why = reason.trim()
                if (!why) return setReasonError('Say why the months are reopened')
                if (why.length > 500) return setReasonError('At most 500 characters')
                setReasonError(null)
                void save(why)
              }}
            >
              <ErrorNote message={saveError} />
              <p className="text-sm font-semibold">
                {toReopen.length === 1 ? 'This month is reopened' : 'These months are reopened'}{' '}
                before the change is saved.
              </p>
              <ul className="mx-list">
                {toReopen.map((m) => (
                  <li key={m.reportId} className="mx-row">
                    <span>
                      <b>{m.engagementName}</b> · {periodLabel(period)}
                    </span>
                    <Chip tone="warn">{REPORT_STATUS_LABELS[m.status]}</Chip>
                  </li>
                ))}
              </ul>
              <Field label="Why they are reopened" required error={reasonError}>
                <textarea
                  className={inputClass}
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <div className="ad-actions justify-end">
                <Button
                  kind="ghost"
                  onClick={() => {
                    setReopening(false)
                    setSaveError(null)
                  }}
                >
                  Cancel
                </Button>
                <Button kind="navy" type="submit" disabled={saving}>
                  {saving
                    ? 'Saving…'
                    : `Reopen ${toReopen.length === 1 ? 'it' : `all ${toReopen.length}`} and save`}
                </Button>
              </div>
            </form>
          </Modal>
        )}
        {viewing && (
          <Modal title={viewing.title} onClose={() => setViewing(null)} wide>
            <Suspense fallback={<p className="text-sm text-soft">Opening the file…</p>}>
              <StatementViewer
                doc={{
                  id: viewing.src,
                  sensitivity: viewing.personal ? 'personal' : 'financial',
                  // A pay stub opens here like the other payroll files (owner's decision, 2026-10-16).
                  kind: viewing.personal ? 'paystub' : undefined,
                }}
                src={viewing.src}
                page={viewing.page}
                mark={viewing.mark ?? undefined}
                downloadName={viewing.fileName}
              />
            </Suspense>
          </Modal>
        )}
      </Card>
    </>
  )
}

/** The reconciliation: every pay found and where it landed, and the items still missing proof. */
function Reconciliation({
  workspaceId,
  period,
  data,
  error,
  onChange,
  d,
}: {
  workspaceId: string
  period: string
  data: PayrollReconciliationDto | null
  error: string | null
  onChange: (r: PayrollReconciliationDto) => void
  /** Only what is not resolved, its tiles filtering one grid. */
  d: {
    filter: ResolveKind | null
    onFilter: (k: ResolveKind | null) => void
    cards: EngagementPayrollCardDto[] | null
    files: WorkspacePayrollFilesDto | null
    colors: Map<string, string>
  }
}) {
  const api = useApi()
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [marking, setMarking] = useState<PayLineDto | null>(null)
  const [why, setWhy] = useState('')
  const [whyError, setWhyError] = useState<string | null>(null)
  if (error) return <ErrorNote message={error} />
  if (!data) return <Empty>Loading the reconciliation…</Empty>
  const items = data.unproved.map((u) => u)
  const fits = (p: PayLineDto) =>
    items.filter((u) => u.missing.includes(PAY_SLOT[p.kind])).map((u) => u.item)
  const act = async (
    p: PayLineDto,
    path: string,
    body: unknown,
    method: 'post' | 'del',
    done: string
  ) => {
    setBusy(p.id)
    setActionError(null)
    setNotice(null)
    try {
      const out =
        method === 'post'
          ? await api.post<PayrollReconciliationDto>(
              `/workspaces/${workspaceId}/payroll/lines/${p.id}/${path}`,
              body
            )
          : await api.del<PayrollReconciliationDto>(
              `/workspaces/${workspaceId}/payroll/lines/${p.id}/${path}`
            )
      onChange(out)
      setNotice(done)
      return true
    } catch (e) {
      setActionError((e as Error).message)
      return false
    } finally {
      setBusy(null)
    }
  }
  const link = (p: PayLineDto, item: { target: string; id: string; title: string }) =>
    act(p, 'link', { target: item.target, id: item.id }, 'post', `Linked the pay to ${item.title}.`)
  const action = data.can.change
    ? (p: PayLineDto) => {
        if (p.state === 'matched') return null
        if (p.state === 'not-funded')
          return (
            <Button
              size="sm"
              kind="ghost"
              disabled={busy === p.id}
              onClick={() =>
                void act(p, 'not-funded', undefined, 'del', 'Took back "not grant-funded".')
              }
            >
              Take back
            </Button>
          )
        const options = fits(p)
        const value = chosen[p.id] ?? ''
        return (
          <span className="flex flex-wrap items-center gap-2">
            {p.state === 'guessed' && p.item && (
              <Button
                size="sm"
                kind="navy"
                disabled={busy === p.id}
                onClick={() => void link(p, p.item!)}
              >
                Confirm
              </Button>
            )}
            {options.length > 0 && (
              <>
                <select
                  className={`${inputClass} ad-input-sm`}
                  aria-label={`Link the pay on ${p.fileName} to an item`}
                  value={value}
                  onChange={(e) => setChosen({ ...chosen, [p.id]: e.target.value })}
                >
                  <option value="">Link to…</option>
                  {options.map((i) => (
                    <option key={keyOf(i)} value={keyOf(i)}>
                      {i.engagementName}: {i.title} ({money(i.amount)})
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  kind="navy"
                  disabled={!value || busy === p.id}
                  onClick={() =>
                    void link(
                      p,
                      options.find((i) => keyOf(i) === value)!
                    )
                  }
                >
                  Link
                </Button>
              </>
            )}
            <Button
              size="sm"
              kind="ghost"
              disabled={busy === p.id}
              onClick={() => {
                setWhy('')
                setWhyError(null)
                setActionError(null)
                setMarking(p)
              }}
            >
              Not grant-funded
            </Button>
          </span>
        )
      }
    : undefined
  const body = (
    <div className="grid gap-4">
      <LineCapNotes files={data.filesOverLineCap} />
      {!marking && <ErrorNote message={actionError} />}
      {notice && (
        <Notice tone="ok" fade>
          {notice}
        </Notice>
      )}
      <ResolveGrid
        workspaceId={workspaceId}
        data={data}
        filter={d.filter}
        onFilter={d.onFilter}
        cards={d.cards}
        colors={d.colors}
        action={action}
      />
    </div>
  )
  return (
    <Card title={`Workspace Reconciliation: ${periodLabel(period)}`}>
      {body}
      {marking && (
        <Modal
          title="Not grant-funded"
          onClose={() => {
            setMarking(null)
            setActionError(null)
          }}
        >
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault()
              const reason = why.trim()
              if (!reason) return setWhyError('Say why this pay is not grant-funded')
              if (reason.length > 500) return setWhyError('At most 500 characters')
              setWhyError(null)
              if (
                await act(
                  marking,
                  'not-funded',
                  { reason },
                  'post',
                  'Marked the pay not grant-funded.'
                )
              )
                setMarking(null)
            }}
          >
            <ErrorNote message={actionError} />
            <p className="ad-mono text-sm">{marking.mark?.text ?? marking.fileName}</p>
            <Field
              label="Why it is not grant-funded"
              required
              error={whyError}
              hint="For example: paid from general funds."
            >
              <textarea
                className={inputClass}
                rows={2}
                maxLength={500}
                value={why}
                onChange={(e) => setWhy(e.target.value)}
              />
            </Field>
            <div className="ad-actions justify-end">
              <Button
                kind="ghost"
                onClick={() => {
                  setMarking(null)
                  setActionError(null)
                }}
              >
                Cancel
              </Button>
              <Button kind="navy" type="submit" disabled={busy === marking.id}>
                Mark not grant-funded
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  )
}
