import { useState } from 'react'
import type { ParticipantDto, TagType } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { Button, ErrorNote, Field, Modal, inputClass } from '@/components/ui'
import { TagPicker, typesFor } from '@/components/Tags'

/**
 * A participant of the engagement, by the funder's id and the name the team uses: added, or (`participant`) corrected
 * or removed. A removal is refused while they have payments or records in their file, and the dialog says so.
 */
export function AddParticipantModal({
  engagementId,
  tagTypes,
  engagements,
  name,
  submit,
  participant,
  onClose,
  onAdded,
  onRemoved,
}: {
  /** The engagement to add to; empty with `engagements`, where the person picks it. */
  engagementId: string
  /** Engagements to pick from (adding someone a pay stub names, on the workspace payroll page). */
  engagements?: { id: string; name: string }[]
  /** The name to start from (as a pay stub prints it). */
  name?: string
  tagTypes: TagType[]
  /**
   * Sends a new participant somewhere else than the engagement's own route (the workspace payroll match, which answers
   * the match as it now stands); `onAdded` is then not called.
   */
  submit?: (
    engagementId: string,
    body: { participantId: string; displayName: string; enrollmentStatus: string; tags: string[] }
  ) => Promise<void>
  /** The participant to correct; none to add one. */
  participant?: ParticipantDto
  onClose: () => void
  onAdded: (participant: ParticipantDto) => void
  onRemoved?: (id: string) => void
}) {
  const api = useApi()
  const [participantId, setParticipantId] = useState(participant?.participantId ?? '')
  const [engagement, setEngagement] = useState(engagementId)
  const [displayName, setDisplayName] = useState(participant?.displayName ?? name ?? '')
  const [enrollmentStatus, setEnrollmentStatus] = useState<'new' | 'carryover'>(
    participant?.enrollmentStatus === 'carryover' ? 'carryover' : 'new'
  )
  const [tags, setTags] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (submit && !participant) {
        await submit(engagement, { participantId, displayName, enrollmentStatus, tags })
        return
      }
      const saved = participant
        ? await api.patch<ParticipantDto>(`/participants/${participant.id}`, {
            participantId,
            displayName,
            enrollmentStatus,
          })
        : await api.post<ParticipantDto>(`/engagements/${engagement}/participants`, {
            participantId,
            displayName,
            enrollmentStatus,
            tags,
          })
      onAdded(saved)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!participant || !confirm(`Remove ${participant.displayName} from this engagement?`)) return
    setBusy(true)
    setError(null)
    try {
      await api.del(`/participants/${participant.id}`)
      onRemoved?.(participant.id)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      title={participant ? `Edit ${participant.displayName}` : 'Add a participant'}
      onClose={onClose}
    >
      <form onSubmit={save} className="grid gap-4">
        <ErrorNote message={error} />
        {engagements && (
          <Field label="Engagement" required>
            <select
              className={inputClass}
              value={engagement}
              onChange={(e) => setEngagement(e.target.value)}
              required
            >
              <option value="">Choose an engagement</option>
              {engagements.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Name" required hint="As it appears on the enrollment form">
          <input
            className={inputClass}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            autoFocus={!engagements}
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
        {!participant && typesFor(tagTypes, 'participant').length > 0 && (
          // Not a <label>: a label holding buttons would press the first when its words are clicked.
          <div className="ad-field">
            <span>Tags</span>
            <TagPicker types={tagTypes} target="participant" value={tags} onChange={setTags} />
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {participant && (
              <Button
                type="button"
                kind="ghost"
                className="text-danger"
                onClick={() => void remove()}
                disabled={busy}
              >
                Remove participant
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="primary" disabled={busy}>
              {participant ? 'Save' : 'Add participant'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
