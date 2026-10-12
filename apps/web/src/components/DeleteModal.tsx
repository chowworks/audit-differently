import { useState } from 'react'
import { TermsBox } from '@/components/TermsBox'
import { useApi, useLoad } from '@/hooks/useApi'
import { Button, ErrorNote, Field, Modal, Notice, inputClass } from '@/components/ui'
import {
  DELETE_PHRASE,
  RETAINED_COPY_DAYS,
  type DeletionExportDto,
  type DeletionSummaryDto,
  type ExportPartDto,
} from '@ad/types'

type Target = { kind: 'engagement' | 'workspace'; id: string; name: string }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`

/**
 * Permanent deletion of an engagement or a workspace, owners only. Deliberately slow: what goes, the export
 * (forced download, must finish), the exact name, then the phrase. The API refuses anything less.
 */
export function DeleteModal({
  target,
  engagementsLeft = 0,
  onClose,
  onDeleted,
}: {
  target: Target
  /** A workspace with engagements cannot be deleted yet: the first step says so and offers no way on. */
  engagementsLeft?: number
  onClose: () => void
  onDeleted: () => void | Promise<void>
}) {
  const api = useApi()
  const base = `/${target.kind === 'engagement' ? 'engagements' : 'workspaces'}/${target.id}`
  const { data: summary, error: loadError } = useLoad<DeletionSummaryDto>(
    `${base}/deletion-summary`
  )
  const [step, setStep] = useState(1)
  // Which part is being prepared or downloaded now (0 while the export is being prepared), and which are done.
  const [working, setWorking] = useState<number | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [deletionId, setDeletionId] = useState<string | null>(null)
  const [parts, setParts] = useState<ExportPartDto[] | null>(null)
  const [done, setDone] = useState<number[]>([])
  const [name, setName] = useState('')
  const [phrase, setPhrase] = useState('')
  const [sure, setSure] = useState(false)
  const [rereadTerms, setRereadTerms] = useState(false)
  const [termsRead, setTermsRead] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEngagement = target.kind === 'engagement'
  const needsExport = isEngagement || !!summary?.hasWorkspaceDocuments
  const steps = needsExport ? 4 : 3
  // Without an export the steps are 1 warning, 3 name, 4 phrase: show them as 1, 2, 3.
  const shown = needsExport || step < 3 ? step : step - 1
  const next = () => setStep((s) => (s === 1 && !needsExport ? 3 : s + 1))
  const back = () => {
    // Leaving the last step clears the re-read: it is done each time, in front of the button.
    setTermsRead(false)
    setRereadTerms(false)
    setStep((s) => (s === 3 && !needsExport ? 1 : s - 1))
  }

  const exporting = working !== null
  const allDone = !!parts && parts.every((p) => done.includes(p.n))

  /** One part: the file is checked against what the API sent, and only then counts as done. */
  const downloadPart = async (id: string, p: ExportPartDto) => {
    setWorking(p.n)
    setExportError(null)
    try {
      await api.download(`${base}/deletion/${id}/parts/${p.n}`, p.fileName)
      setDone((d) => (d.includes(p.n) ? d : [...d, p.n]))
    } catch (e) {
      setExportError((e as Error).message)
    } finally {
      setWorking(null)
    }
  }

  /** Prepares the export (the record and its parts); a single part downloads straight away. */
  const prepare = async () => {
    setWorking(0)
    setExportError(null)
    try {
      const made = await api.post<DeletionExportDto>(`${base}/deletion`)
      setDeletionId(made.deletionId)
      setParts(made.parts)
      setDone([])
      if (made.parts.length === 1) await downloadPart(made.deletionId, made.parts[0]!)
      else setWorking(null)
    } catch (e) {
      setExportError((e as Error).message)
      setWorking(null)
    }
  }

  const startOver = () => {
    setParts(null)
    setDeletionId(null)
    setDone([])
    setExportError(null)
  }

  const ready =
    name === target.name &&
    phrase === DELETE_PHRASE &&
    sure &&
    rereadTerms &&
    termsRead &&
    (!needsExport || (!!deletionId && allDone))
  const remove = async () => {
    setDeleting(true)
    setError(null)
    try {
      await api.del(base, {
        ...(deletionId ? { deletionId } : {}),
        confirmName: name,
        confirmPhrase: phrase,
      })
      await onDeleted()
    } catch (e) {
      setError((e as Error).message)
      setDeleting(false)
    }
  }

  const goes = isEngagement
    ? [
        plural(summary?.months ?? 0, 'monthly report') + ' with their ledgers and checks',
        plural(summary?.participants ?? 0, 'participant') + ' and their eligibility files',
        plural(summary?.documents ?? 0, 'uploaded document'),
        'every note, waiver and budget line on the engagement',
      ]
    : [
        'the workspace itself, its people and their roles',
        'its lists, such as the sources of funds',
        plural(summary?.documents ?? 0, 'workspace-level document'),
      ]

  return (
    <Modal
      title={`Delete ${isEngagement ? 'engagement' : 'workspace'}`}
      onClose={onClose}
      wide={step === 4}
    >
      <div className="grid gap-4">
        <p className="text-sm text-soft">
          {engagementsLeft > 0 ? target.name : `Step ${shown} of ${steps} · ${target.name}`}
        </p>
        <ErrorNote message={loadError} />

        {step === 1 && engagementsLeft > 0 && (
          <>
            <Notice tone="warn">
              <b>
                <span aria-hidden="true">⚠️</span> This workspace still has{' '}
                {plural(engagementsLeft, 'engagement')}.
              </b>{' '}
              A workspace can be deleted only when it is empty. Open each engagement, delete it from
              the Danger zone at the bottom of its page, then come back here.
            </Notice>
            <div className="flex justify-end">
              <Button onClick={onClose}>Close</Button>
            </div>
          </>
        )}

        {step === 1 && engagementsLeft === 0 && (
          <>
            <Notice tone="danger">
              <b>
                <span aria-hidden="true">🚨</span> This is permanent and cannot be undone.
              </b>{' '}
              Everything below is deleted for good, for every person in the workspace.
            </Notice>
            {summary ? (
              <ul className="list-disc pl-5 text-sm">
                {goes.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            ) : (
              !loadError && <p className="text-sm text-soft">Counting what would be deleted…</p>
            )}
            <p className="text-sm">
              {needsExport
                ? `You will download a full export first. We also keep our own copy of the export for ${RETAINED_COPY_DAYS} days, only to cover an accidental delete or a failed download, and then it is destroyed. `
                : 'There is nothing to export, so nothing is kept after this. '}
              Your organization is responsible for keeping every record its funder, contract or the
              law requires.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button kind="danger" onClick={next} disabled={!summary}>
                I understand, continue
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h3 className="text-base font-bold">Download the export first</h3>
            <p className="text-sm">
              {isEngagement
                ? 'A zip with the engagement, its months, ledgers, participants and every uploaded document. '
                : 'A zip with the documents kept at the workspace level. '}
              Save it somewhere your organization keeps its records. You cannot continue until the
              download has finished.
            </p>
            <ErrorNote message={exportError} />
            {parts && parts.length > 1 && (
              <>
                <p className="text-sm">
                  This export is big, so it comes in {parts.length} parts. Download each one and
                  save them together. Each part opens on its own, and your browser may ask to allow
                  several downloads.
                </p>
                <ul className="grid gap-2">
                  {parts.map((p) => (
                    <li key={p.n} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm">
                        Part {p.n} of {parts.length} ({size(p.bytes ?? p.sourceBytes)}
                        {p.bytes === undefined ? ' of files' : ''})
                        {done.includes(p.n) && ' · downloaded'}
                      </span>
                      <Button
                        size="sm"
                        onClick={() => downloadPart(deletionId!, p)}
                        disabled={exporting}
                      >
                        {working === p.n
                          ? 'Downloading…'
                          : done.includes(p.n)
                            ? 'Download again'
                            : 'Download'}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {exporting && (
              <>
                <div className="ad-progress">
                  <i style={{ width: '100%' }} />
                </div>
                <p className="text-sm text-soft">
                  Preparing and downloading the export. This can take a minute; keep this window
                  open.
                </p>
              </>
            )}
            {allDone && !exporting && (
              <Notice tone="ok">
                {parts!.length > 1
                  ? 'All parts have downloaded. Check that each file opens before you continue.'
                  : 'The export has downloaded. Check that the file opens before you continue.'}
              </Notice>
            )}
            <div className="flex flex-wrap justify-between gap-2">
              <Button onClick={back} disabled={exporting}>
                Back
              </Button>
              <span className="flex gap-2">
                {parts && exportError && (
                  <Button onClick={startOver} disabled={exporting}>
                    Start the export again
                  </Button>
                )}
                {(!parts || parts.length === 1) && (
                  <Button
                    kind="primary"
                    onClick={() => (parts ? downloadPart(deletionId!, parts[0]!) : prepare())}
                    disabled={exporting}
                  >
                    {allDone ? 'Download it again' : exportError ? 'Try again' : 'Download export'}
                  </Button>
                )}
                <Button kind="danger" onClick={next} disabled={!allDone || exporting}>
                  Continue
                </Button>
              </span>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <Field
              label={`Type the ${isEngagement ? 'engagement' : 'workspace'} name exactly`}
              hint={target.name}
            >
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                autoFocus
              />
            </Field>
            <div className="flex justify-between gap-2">
              <Button onClick={back}>Back</Button>
              <Button kind="danger" onClick={next} disabled={name !== target.name}>
                Continue
              </Button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <Field label={`Type “${DELETE_PHRASE}” to confirm`}>
              <input
                className={inputClass}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
                autoFocus
              />
            </Field>
            <div className="grid gap-2">
              <span className="text-sm font-semibold">Read the Terms &amp; Conditions again</span>
              <TermsBox onReadAll={() => setTermsRead(true)} />
              {termsRead ? (
                <p className="ad-terms-done">
                  ✓ You have reached the end of the Terms &amp; Conditions.
                </p>
              ) : (
                <p className="ad-terms-scroll" role="status">
                  ↓ Scroll to the bottom of the Terms &amp; Conditions to continue
                </p>
              )}
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={rereadTerms}
                disabled={!termsRead}
                onChange={(e) => setRereadTerms(e.target.checked)}
              />
              <span>I have read the Terms &amp; Conditions again.</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={sure}
                disabled={!termsRead}
                onChange={(e) => setSure(e.target.checked)}
              />
              <span>I understand this cannot be undone.</span>
            </label>
            <ErrorNote message={error} />
            <div className="flex justify-between gap-2">
              <Button onClick={back} disabled={deleting}>
                Back
              </Button>
              <Button kind="danger" onClick={remove} disabled={!ready || deleting}>
                {deleting
                  ? 'Deleting…'
                  : `Delete this ${isEngagement ? 'engagement' : 'workspace'} permanently`}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
