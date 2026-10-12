import { useState } from 'react'
import type { DocumentDto, EligibilityItemDef, EngagementDetail, ParticipantDto } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { missingItems } from '@/lib/workflow'
import { Button, Chip, Empty, ErrorNote, Modal, inputClass } from '@/components/ui'
import { DocumentLink } from '@/components/DocumentLink'

const ENROLLMENT: Record<string, string> = { new: 'new this year', carryover: 'carried over' }

/**
 * Step 5's list: every participant with how much of their eligibility file is on file, searchable, with a
 * filter for files that still miss something. Opening one shows its checklist, with an upload in place
 * for each missing item and Previous / Next through the list as filtered.
 */
export function ParticipantsModal({
  c,
  items,
  initialFileFor,
  onClose,
  onAdd,
  onChanged,
}: {
  c: EngagementDetail
  items: EligibilityItemDef[]
  /** Open straight on this participant's file. */
  initialFileFor?: string
  onClose: () => void
  onAdd: () => void
  onChanged: () => Promise<void>
}) {
  const [fileFor, setFileFor] = useState<string | null>(initialFileFor ?? null)
  const [q, setQ] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const files = c.participants.map((p) => {
    const have = new Set(p.documents.map((d) => d.purpose))
    return {
      p,
      missing: missingItems(p, items),
      onFile: items.filter((i) => have.has(i.key)).length,
      attested: have.has('self-attestation'),
    }
  })
  const complete = files.filter((f) => f.missing.length === 0).length
  const needle = q.trim().toLowerCase()
  const shown = files.filter(
    (f) =>
      (!onlyMissing || f.missing.length > 0) &&
      (!needle || `${f.p.displayName} ${f.p.participantId}`.toLowerCase().includes(needle))
  )
  const current = fileFor ? c.participants.find((x) => x.id === fileFor) : undefined
  // Previous / Next walk the list as it is filtered; if the current one fell out of it, walk everyone.
  const order = shown.some((f) => f.p.id === fileFor)
    ? shown.map((f) => f.p.id)
    : c.participants.map((p) => p.id)

  return (
    <Modal
      title={current ? `${current.displayName}'s eligibility file` : 'Participants'}
      onClose={onClose}
      wide
    >
      {current ? (
        <ParticipantFile
          c={c}
          items={items}
          p={current}
          order={order}
          onBack={() => setFileFor(null)}
          onSwitch={setFileFor}
          onChanged={onChanged}
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Chip tone={files.length > 0 && complete === files.length ? 'ok' : 'warn'}>
              {complete} of {files.length} complete
            </Chip>
            <input
              className={`${inputClass} max-w-xs`}
              placeholder="Search by name or id"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={onlyMissing}
                onChange={(e) => setOnlyMissing(e.target.checked)}
              />
              only files with something missing
            </label>
            <span className="flex-1" />
            {c.canManage && (
              <Button size="sm" onClick={onAdd}>
                + Add participant
              </Button>
            )}
          </div>
          <p className="mb-3 text-xs text-soft">
            Open a file to see each item and upload what is missing. Personal records: download
            only, every read logged.
          </p>
          {files.length === 0 && (
            <Empty>
              No participants yet. Add each person the program serves the day they enroll.
            </Empty>
          )}
          {files.length > 0 && shown.length === 0 && <Empty>Nothing matches.</Empty>}
          {shown.length > 0 && (
            <div className="max-h-[60vh] overflow-auto">
              <table className="ad-table">
                <tbody>
                  {shown.map((f) => (
                    <tr key={f.p.id}>
                      <td className="whitespace-nowrap">
                        <span className="font-semibold">{f.p.displayName}</span>
                        <span className="ad-table-sub">
                          <span className="ad-mono">{f.p.participantId}</span> ·{' '}
                          {ENROLLMENT[f.p.enrollmentStatus] ?? f.p.enrollmentStatus}
                        </span>
                      </td>
                      <td className="w-[32%]">
                        <div className="mb-1 text-xs text-soft">
                          {f.onFile} of {items.length} items on file
                        </div>
                        <div className="ad-progress ad-progress-sm">
                          <i
                            style={{ width: `${(f.onFile / Math.max(1, items.length)) * 100}%` }}
                          />
                        </div>
                        {f.missing.length > 0 && (
                          <p className="mt-1 text-xs font-semibold text-danger">
                            Missing: {f.missing.map((i) => i.label.toLowerCase()).join(', ')}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        {f.missing.length === 0 ? (
                          <Chip tone="ok">complete</Chip>
                        ) : (
                          <Chip tone={f.attested ? 'info' : 'danger'} fill={!f.attested}>
                            {f.missing.length} missing
                          </Chip>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <Button size="sm" onClick={() => setFileFor(f.p.id)}>
                          {c.canManage && f.missing.length > 0 ? 'Complete file' : 'Open file'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

/** One participant's checklist: every item, on file or not, with an upload in place for each missing one. */
function ParticipantFile({
  c,
  items,
  p,
  order,
  onBack,
  onSwitch,
  onChanged,
}: {
  c: EngagementDetail
  items: EligibilityItemDef[]
  p: ParticipantDto
  order: string[]
  onBack: () => void
  onSwitch: (id: string) => void
  onChanged: () => Promise<void>
}) {
  const api = useApi()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const have = new Map(p.documents.map((d) => [d.purpose, d.document]))
  const missing = missingItems(p, items)
  const idx = order.indexOf(p.id)
  const n = order.length

  const upload = async (item: EligibilityItemDef, file: File) => {
    setBusy(item.key)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('workspaceId', c.workspaceId)
      form.append('engagementId', c.id)
      form.append('kind', item.key === 'enrollment-form' ? 'enrollment-form' : 'eligibility-record')
      const doc = await api.upload<DocumentDto>('/documents', form)
      await api.post(`/participants/${p.id}/documents`, { documentId: doc.id, purpose: item.key })
      await onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <ErrorNote message={error} />
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <Button size="sm" kind="ghost" onClick={onBack} disabled={!!busy}>
          ‹ All participants
        </Button>
        <span className="ad-mono">{p.participantId}</span>
        <span className="text-soft">{ENROLLMENT[p.enrollmentStatus] ?? p.enrollmentStatus}</span>
        {missing.length === 0 ? (
          <Chip tone="ok">complete</Chip>
        ) : (
          <Chip tone={have.has('self-attestation') ? 'info' : 'danger'} fill>
            {missing.length} missing
          </Chip>
        )}
        <span className="flex-1" />
        {n > 1 && idx >= 0 && (
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => onSwitch(order[idx - 1]!)}
              disabled={idx === 0 || !!busy}
            >
              ‹ Previous
            </Button>
            <span className="text-xs text-soft">
              {idx + 1} of {n}
            </span>
            <Button
              size="sm"
              onClick={() => onSwitch(order[idx + 1]!)}
              disabled={idx === n - 1 || !!busy}
            >
              Next ›
            </Button>
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-soft">
        Required items are marked *. Each upload saves at once. Personal records: download only,
        every read logged.
      </p>
      <table className="ad-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>On file</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const doc = have.get(item.key)
            return (
              <tr key={item.key}>
                <td>
                  <span className="font-semibold">
                    {item.label}
                    {item.required && <span className="text-danger">*</span>}
                  </span>
                </td>
                <td>
                  {doc ? (
                    <>
                      <Chip tone="ok">on file</Chip>
                      <span className="ad-table-sub">
                        {doc.fileName} · {shortDate(doc.uploadedAt)}
                      </span>
                    </>
                  ) : item.required ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="ad-check-dot bad" aria-hidden="true">
                        !
                      </span>
                      <Chip tone="danger">missing</Chip>
                    </span>
                  ) : (
                    <Chip tone="muted">not on file</Chip>
                  )}
                </td>
                <td className="whitespace-nowrap text-right">
                  {doc ? (
                    <DocumentLink doc={doc} className="text-sm font-semibold">
                      open
                    </DocumentLink>
                  ) : c.canManage ? (
                    <label
                      className={`ad-btn ad-btn-sm cursor-pointer ${busy ? 'opacity-60' : ''}`}
                    >
                      {busy === item.key ? 'Uploading…' : 'Upload'}
                      <input
                        type="file"
                        className="sr-only"
                        accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx"
                        disabled={!!busy}
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) void upload(item, f)
                          e.target.value = ''
                        }}
                      />
                    </label>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}
