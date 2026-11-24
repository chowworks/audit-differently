import { useState } from 'react'
import type { EngagementContact, EngagementDetail } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { Button, Card, ErrorNote, Field, Modal, inputClass } from '@/components/ui'

type Edit = EngagementContact | 'new' | null

/**
 * The contacts on an award (G-09, issue #94): people at the funder and partner organizations the team may reach.
 * Several per award. Owners and bookkeepers add, change and remove them; an auditor reads them. Shown on the award
 * page beside the figures.
 */
export function ContactsCard({
  c,
  onChanged,
}: {
  c: EngagementDetail
  /** The engagement as saved, so the page shows it without fetching again. */
  onChanged: (saved: EngagementDetail) => void
}) {
  const [edit, setEdit] = useState<Edit>(null)
  const add = c.canManage && (
    <Button kind="primary" size="sm" onClick={() => setEdit('new')}>
      + Add contact
    </Button>
  )
  return (
    <Card eyebrow="Award" title="Contacts" aside={add}>
      {c.contacts.length === 0 ? (
        <p className="text-sm text-soft">
          No contacts yet.{c.canManage ? ' Add the people you reach at the funder.' : ''}
        </p>
      ) : (
        <ul className="grid gap-3">
          {c.contacts.map((ct) => (
            <li key={ct.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-navy">{ct.name}</p>
                {(ct.jobTitle || ct.organization) && (
                  <p className="text-sm text-soft">
                    {[ct.jobTitle, ct.organization].filter(Boolean).join(' · ')}
                  </p>
                )}
                {ct.email && (
                  <p className="truncate text-sm">
                    <a
                      className="text-navy no-underline hover:underline"
                      href={`mailto:${ct.email}`}
                    >
                      {ct.email}
                    </a>
                  </p>
                )}
                {ct.phone && <p className="text-sm">{ct.phone}</p>}
              </div>
              {c.canManage && (
                <Button kind="ghost" size="sm" onClick={() => setEdit(ct)}>
                  Edit
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <ContactModal
          engagementId={c.id}
          contact={edit === 'new' ? undefined : edit}
          onClose={() => setEdit(null)}
          onSaved={(saved) => {
            setEdit(null)
            onChanged(saved)
          }}
        />
      )}
    </Card>
  )
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PHONE = /^[0-9+().\- ]+$/

/** One award contact (G-09). Name is required, and at least one of email or phone, so it can always be reached. */
function ContactModal({
  engagementId,
  contact,
  onClose,
  onSaved,
}: {
  engagementId: string
  /** The contact to change; none to add one. */
  contact?: EngagementContact
  onClose: () => void
  onSaved: (saved: EngagementDetail) => void
}) {
  const api = useApi()
  const [name, setName] = useState(contact?.name ?? '')
  const [organization, setOrganization] = useState(contact?.organization ?? '')
  const [jobTitle, setJobTitle] = useState(contact?.jobTitle ?? '')
  const [email, setEmail] = useState(contact?.email ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Shown only once the person has pressed Save, so the form does not scold them as they type.
  const [tried, setTried] = useState(false)

  const problems = {
    name: !name.trim() ? 'Name the contact' : null,
    email:
      email.trim() && !EMAIL.test(email.trim())
        ? 'Enter a valid email, like name@example.org'
        : null,
    phone: phone.trim() && !PHONE.test(phone.trim()) ? 'Use digits and + ( ) - only' : null,
    reach:
      !email.trim() && !phone.trim()
        ? 'Give an email or a phone number, so the contact can be reached'
        : null,
  }
  const err = (k: keyof typeof problems) => (tried ? problems[k] : null)
  const ok = !problems.name && !problems.email && !problems.phone && !problems.reach

  const save = async () => {
    setTried(true)
    if (!ok) return
    setBusy(true)
    setError(null)
    const body = {
      name: name.trim(),
      organization: organization.trim() || null,
      jobTitle: jobTitle.trim() || null,
      email: email.trim() || null,
      phone: phone.trim() || null,
    }
    const base = `/engagements/${engagementId}/contacts`
    try {
      onSaved(
        contact
          ? await api.patch<EngagementDetail>(`${base}/${contact.id}`, body)
          : await api.post<EngagementDetail>(base, body)
      )
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const remove = () => {
    if (!contact || !confirm(`Remove ${contact.name} from this award's contacts?`)) return
    setBusy(true)
    setError(null)
    api
      .del<EngagementDetail>(`/engagements/${engagementId}/contacts/${contact.id}`)
      .then(onSaved)
      .catch((e: Error) => {
        setError(e.message)
        setBusy(false)
      })
  }

  return (
    <Modal title={contact ? `Edit ${contact.name}` : 'Add a contact'} onClose={onClose}>
      <ErrorNote message={error} />
      <div className="grid gap-4">
        <Field label="Name" required error={err('name')}>
          <input
            className={inputClass}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Organization">
            <input
              className={inputClass}
              placeholder="The funder or partner"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
            />
          </Field>
          <Field label="Job title">
            <input
              className={inputClass}
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" error={err('email') ?? err('reach')}>
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Phone" error={err('phone')}>
            <input
              className={inputClass}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          {contact && (
            <Button kind="ghost" className="text-danger" onClick={remove} disabled={busy}>
              Remove contact
            </Button>
          )}
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button kind="navy" onClick={() => void save()} disabled={busy}>
            {contact ? 'Save' : 'Add contact'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
