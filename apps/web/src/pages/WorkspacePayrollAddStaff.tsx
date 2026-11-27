import { useState } from 'react'
import type { StaffListDto, WorkspacePayrollRunDto } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import { MultiSelect } from '@/components/MultiSelect'
import { Button, ErrorNote, Field, Modal, inputClass } from '@/components/ui'
import { besideField, checkStaff, problemsOf } from '@/pages/staffing/staff-paste'

/**
 * Someone a payroll register pays who is on no staff list, added from the match screen: to the staff list, with a role
 * and the engagements they work on. The match is worked out again from the files already read, so nothing is re-run.
 */
export function AddStaffFoundModal({
  runId,
  name: found,
  list,
  onClose,
  onAdded,
}: {
  /** The open match: the add goes through it and answers it as it now matches. */
  runId: string
  /** The name the register prints. */
  name: string
  list: StaffListDto
  onClose: () => void
  /** The match and the staff list after the add. */
  onAdded: (run: WorkspacePayrollRunDto, list: StaffListDto) => void
}) {
  const api = useApi()
  const [name, setName] = useState(found)
  const [role, setRole] = useState('')
  const [ticked, setTicked] = useState<string[]>([])
  const [nameError, setNameError] = useState<string | null>(null)
  const [roleError, setRoleError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const engagements = list.engagements.filter((e) => e.status !== 'closed')
  const showProblems = (problems: { field: 'name' | 'role'; message: string }[]) => {
    const of = (f: 'name' | 'role') => problems.find((p) => p.field === f)
    setNameError(of('name') ? besideField({ row: 1, ...of('name')! }) : null)
    setRoleError(of('role') ? besideField({ row: 1, ...of('role')! }) : null)
  }
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setError(null)
    const problems = checkStaff([{ name, role }], list.staff)
    showProblems(problems)
    if (problems.length) return
    setBusy(true)
    try {
      const done = await api.post<{ run: WorkspacePayrollRunDto; staff: StaffListDto }>(
        `/workspace-payroll-match/${runId}/staff`,
        { name, role: role || null, engagementIds: ticked }
      )
      onAdded(done.run, done.staff)
    } catch (e) {
      const refused = e instanceof ApiError ? problemsOf(e.body) : null
      if (refused) showProblems(refused)
      else setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Add ${found} to staff`} onClose={onClose}>
      <form onSubmit={save} className="grid gap-4">
        <ErrorNote message={error} />
        <Field label="Name" required error={nameError}>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="Role" error={roleError}>
          <input
            className={inputClass}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            autoFocus
          />
        </Field>
        {engagements.length > 0 && (
          // Not a <label>: the picker is its own button and search box.
          <div className="ad-field">
            <span>Engagements they work on</span>
            <MultiSelect
              label="Engagements they work on"
              placeholder="Search and choose engagements"
              options={engagements.map((e) => ({ value: e.id, label: e.name }))}
              value={ticked}
              onChange={setTicked}
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="navy" disabled={busy}>
            Add to staff
          </Button>
        </div>
      </form>
    </Modal>
  )
}
