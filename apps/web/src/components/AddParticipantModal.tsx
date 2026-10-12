import { useState } from 'react'
import type { ParticipantDto } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { Button, ErrorNote, Field, Modal, inputClass } from '@/components/ui'

/** A participant of the engagement, by the funder's id and the name the team uses. */
export function AddParticipantModal({
  engagementId,
  onClose,
  onAdded,
}: {
  engagementId: string
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const api = useApi()
  const [participantId, setParticipantId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [enrollmentStatus, setEnrollmentStatus] = useState<'new' | 'carryover'>('new')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post<ParticipantDto>(`/engagements/${engagementId}/participants`, {
        participantId,
        displayName,
        enrollmentStatus,
      })
      await onAdded()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title="Add a participant" onClose={onClose}>
      <form onSubmit={save} className="grid gap-4">
        <ErrorNote message={error} />
        <Field label="Name" required hint="As it appears on the enrollment form">
          <input
            className={inputClass}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label="Participant id" required hint="The funder's id for this person">
          <input
            className={`${inputClass} ad-mono`}
            value={participantId}
            onChange={(e) => setParticipantId(e.target.value)}
            required
          />
        </Field>
        <Field label="Enrollment">
          <select
            className={inputClass}
            value={enrollmentStatus}
            onChange={(e) => setEnrollmentStatus(e.target.value as 'new' | 'carryover')}
          >
            <option value="new">New this program year</option>
            <option value="carryover">Carried over from last year</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="primary" disabled={busy}>
            Add participant
          </Button>
        </div>
      </form>
    </Modal>
  )
}
