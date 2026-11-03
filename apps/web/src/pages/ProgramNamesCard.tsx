import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  NOT_OURS,
  programOf,
  unsetPrograms,
  type ProgramNames,
  type ProgramNamesDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { Button, Card, ErrorNote } from '@/components/ui'

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
  const addFile = (file: File | undefined) => {
    if (!file) return
    const form = new FormData()
    form.append('file', file)
    void run(() => api.upload<ProgramNamesDto>(`/workspaces/${workspaceId}/program-names`, form))
  }
  const programs = data?.programs ?? []
  const engagements = data?.engagements ?? []
  // A program an owner linked; else the engagement it is by its name ("auto"); marked not one of ours; else not set.
  const byName = (g: ProgramNames) =>
    g.engagementId ? null : (engagements.find((e) => programOf(programs, e) === g) ?? null)
  const unset = new Set(unsetPrograms(programs, engagements))
  const choice = (g: ProgramNames) =>
    g.engagementId === NOT_OURS
      ? 'none'
      : g.engagementId
        ? g.engagementId
        : byName(g)
          ? 'auto'
          : 'unset'
  // Opened from the payroll page's action (#program-names): brought into view once the list is read.
  const { hash } = useLocation()
  useEffect(() => {
    if (data && hash === '#program-names')
      document.getElementById('program-names')?.scrollIntoView({ block: 'start' })
  }, [data, hash])
  return (
    <Card
      title="Program names"
      aside={
        canManage && (
          <label className="ad-btn ad-btn-navy ad-btn-sm cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2">
            Add from a file
            <input
              type="file"
              accept=".xlsx,.csv"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                addFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
        )
      }
    >
      <p className="mb-3 text-sm text-soft">
        The names each program goes by in your books and your payroll company&apos;s files (a class
        in the books, a project or job in payroll), so the payroll match reads a company-wide export
        as it is and counts each row on its own engagement. Add a mapping file whose rows each name
        one program, or put it in the payroll zip&apos;s Program names folder; each file is merged
        with the list and never stored. A program is an engagement&apos;s when one of its names is
        the engagement&apos;s name, or when you link it.
      </p>
      <ErrorNote message={error ?? loadError} />
      {programs.length === 0 ? (
        <p className="text-sm text-soft">No program names yet.</p>
      ) : (
        <div className="ad-table-wrap">
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
                        {unset.has(g) && (
                          <option value="unset" disabled>
                            Not set: choose one
                          </option>
                        )}
                        {byName(g) && <option value="auto">{byName(g)!.name} (by its name)</option>}
                        <option value="none">Not one of ours</option>
                        {engagements.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (engagements.find((e) => e.id === g.engagementId)?.name ??
                      byName(g)?.name ??
                      (g.engagementId === NOT_OURS ? 'Not one of ours' : 'Not set'))
                    )}
                  </td>
                  {canManage && (
                    <td>
                      <Button
                        kind="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Remove ${g.names[0]}`}
                        onClick={() => void save(programs.filter((_, j) => j !== i))}
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
    </Card>
  )
}
