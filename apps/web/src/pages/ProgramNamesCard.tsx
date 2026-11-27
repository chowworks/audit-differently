import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  NOT_OURS,
  PROGRAM_NAMES_FOLDER,
  programOf,
  type ProgramNames,
  type ProgramNamesDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { BulkAddModal } from '@/components/BulkAddModal'
import { Button, Card, ErrorNote, Field, Modal, inputClass } from '@/components/ui'

/** Bulk Add Names' sample: a heading row, then one program a row. Fictional rows, meant to be replaced. */
const PROGRAM_SAMPLE = [
  'Books class,Payroll project,Other name',
  'Youth Works,YW-2026,Summer Youth Works',
  'Adult Pathways,AP Training,',
].join('\r\n')

const PROGRAM_COLUMNS: [string, string][] = [
  ['Books class', 'the program as your books name it (a class)'],
  ['Payroll project', 'the program as your payroll company names it (a project or job)'],
  ['Other name', 'optional: any other name it goes by; add columns for more'],
]

/**
 * The workspace's program names (owner's decision, 2026-11-01): each program's names in the books and the payroll
 * company's files, so a company-wide export is split by program as it is. Filled from a mapping file (the payroll zip's
 * "Program names" folder, or chosen here), each file merged with the list; owners link a program to its engagement when
 * none of its names is the engagement's name, and remove one. Owners and auditors read it.
 */
export function ProgramNamesCard({
  workspaceId,
  canManage,
}: {
  workspaceId: string
  canManage: boolean
}) {
  const api = useApi()
  const {
    data,
    error: loadError,
    setData,
  } = useLoad<ProgramNamesDto>(`/workspaces/${workspaceId}/program-names`)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const run = async (work: () => Promise<ProgramNamesDto>) => {
    setBusy(true)
    setError(null)
    try {
      const out = await work()
      setData(out)
      if (out.conflicts?.length)
        setError(
          `${out.conflicts.length === 1 ? '1 row was' : `${out.conflicts.length} rows were`} left out: each names programs linked to different engagements (${out.conflicts[0]!.join(' · ')}).`
        )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const save = (programs: ProgramNames[]) =>
    run(() => api.put<ProgramNamesDto>(`/workspaces/${workspaceId}/program-names`, { programs }))
  const [bulk, setBulk] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)
  const addFile = async (file: File) => {
    const form = new FormData()
    form.append('file', file)
    // A refusal throws to the dialog, which shows it; rows left out are said on the card, as after a hand-made change.
    const out = await api.upload<ProgramNamesDto>(`/workspaces/${workspaceId}/program-names`, form)
    await run(async () => out)
  }
  const programs = data?.programs ?? []
  const engagements = data?.engagements ?? []
  // A program an owner linked; else the engagement it is by its name ("auto"); else, or marked so, not linked.
  const byName = (g: ProgramNames) =>
    g.engagementId ? null : (engagements.find((e) => programOf(programs, e) === g) ?? null)
  const choice = (g: ProgramNames) =>
    g.engagementId && g.engagementId !== NOT_OURS ? g.engagementId : byName(g) ? 'auto' : 'none'
  // Opened from the payroll page's action (#program-names): brought into view once the list is read.
  const { hash } = useLocation()
  useEffect(() => {
    if (data && hash === '#program-names')
      document.getElementById('program-names')?.scrollIntoView({ block: 'start' })
  }, [data, hash])
  return (
    <Card
      title="Map Payroll Programs"
      aside={
        canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button kind="navy" size="sm" disabled={busy} onClick={() => setBulk(true)}>
              Bulk Add Names
            </Button>
            <Button kind="primary" size="sm" disabled={busy} onClick={() => setAdding(true)}>
              + Add a name
            </Button>
          </div>
        )
      }
    >
      <p className="mb-3 text-sm text-soft">
        The names each program goes by in your books and your payroll company&apos;s files (a class
        in the books, a project or job in payroll), so the payroll match reads a company-wide export
        as it is and counts each row on its own engagement. Add a mapping file whose rows each name
        one program, or put it in the payroll zip&apos;s {PROGRAM_NAMES_FOLDER} folder; each file is
        merged with the list and never stored. A program is an engagement&apos;s when one of its
        names is the engagement&apos;s name, or when you link it.
      </p>
      <ErrorNote message={error ?? loadError} />
      {programs.length === 0 ? (
        <p className="text-sm text-soft">No program names yet.</p>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Names</th>
                <th>Engagement</th>
                {canManage && <th aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {programs.map((g, i) => (
                <tr key={`${i}-${g.names[0]}`}>
                  <td>{g.names.join(' · ')}</td>
                  <td>
                    {canManage ? (
                      <select
                        className="ad-input ad-input-sm"
                        value={choice(g)}
                        disabled={busy}
                        aria-label={`Engagement of ${g.names[0]}`}
                        onChange={(e) =>
                          void save(
                            programs.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    engagementId:
                                      e.target.value === 'auto'
                                        ? null
                                        : e.target.value === 'none'
                                          ? NOT_OURS
                                          : e.target.value,
                                  }
                                : x
                            )
                          )
                        }
                      >
                        {byName(g) && <option value="auto">{byName(g)!.name} (by its name)</option>}
                        <option value="none">Not linked</option>
                        {engagements.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (engagements.find((e) => e.id === g.engagementId)?.name ??
                      byName(g)?.name ??
                      'Not linked')
                    )}
                  </td>
                  {canManage && (
                    <td>
                      <Button
                        kind="ghost"
                        size="sm"
                        className="text-danger"
                        disabled={busy}
                        aria-label={`Remove ${g.names[0]}`}
                        onClick={() => setRemoving(i)}
                      >
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {removing !== null && programs[removing] && (
        <Modal title="Remove this program?" onClose={() => setRemoving(null)}>
          <div className="grid gap-3 text-sm">
            <p className="font-bold">
              <span aria-hidden="true">⚠️</span> {programs[removing].names.join(' · ')} will no
              longer be read as a program.
            </p>
            <p>
              Payroll rows already filed stay where they are. The next payroll match that finds
              these names counts them on no engagement until they are added again. The removal is
              recorded in the workspace history.
            </p>
            <div className="flex justify-end gap-2">
              <Button kind="ghost" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                kind="danger"
                disabled={busy}
                onClick={() =>
                  void save(programs.filter((_, j) => j !== removing)).then(() => setRemoving(null))
                }
              >
                Remove
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {bulk && (
        <BulkAddModal
          title="Bulk Add Names"
          lead="Add many programs at once, each with every name it goes by."
          columns={PROGRAM_COLUMNS}
          note="Keep the heading row. Rows that share a name are one program."
          sample={{ fileName: 'program-names-sample.csv', csv: PROGRAM_SAMPLE }}
          onFile={addFile}
          onClose={() => setBulk(false)}
        />
      )}
      {adding && (
        <AddProgramModal
          programs={programs}
          engagements={engagements}
          onClose={() => setAdding(false)}
          onAdd={async (p) => {
            await save([...programs, p])
            setAdding(false)
          }}
        />
      )}
    </Card>
  )
}

/** One program added by hand: its names in the books and the payroll company's files, and its engagement. */
function AddProgramModal({
  programs,
  engagements,
  onClose,
  onAdd,
}: {
  programs: ProgramNames[]
  engagements: ProgramNamesDto['engagements']
  onClose: () => void
  onAdd: (p: ProgramNames) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [engagementId, setEngagementId] = useState('auto')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const names = [
    ...new Set(
      text
        .split(/\n|,/)
        .map((n) => n.trim())
        .filter(Boolean)
    ),
  ]
  const key = (n: string) => n.trim().toLowerCase()
  const taken = names.filter((n) => programs.some((g) => g.names.some((x) => key(x) === key(n))))
  const problem = !names.length
    ? 'Give at least one name'
    : taken.length
      ? `Already on the list: ${taken.join(', ')}`
      : null
  const save = async () => {
    setTried(true)
    if (problem) return
    setBusy(true)
    await onAdd({
      names,
      engagementId:
        engagementId === 'auto' ? null : engagementId === 'none' ? NOT_OURS : engagementId,
    })
    setBusy(false)
  }
  return (
    <Modal title="Add a program" onClose={onClose}>
      <div className="grid gap-3">
        <Field
          label="Names"
          required
          hint="Each name the program goes by in the books (a class) or in payroll (a project or job), one per line"
          error={tried || taken.length ? problem : null}
        >
          <textarea
            className={inputClass}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <Field label="Engagement">
          <select
            className={inputClass}
            value={engagementId}
            onChange={(e) => setEngagementId(e.target.value)}
          >
            <option value="auto">The engagement of its name, if any</option>
            <option value="none">Not linked</option>
            {engagements.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button kind="navy" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
      </div>
    </Modal>
  )
}
