import { useState } from 'react'
import { CONTACT_TOPICS, CONTACT_TOPIC_LABELS, type ContactTopic } from '@ad/types'
import { useSession } from '@/auth/session'
import { ApiError, apiFetch } from '@/services/api'
import { Button, Card, ErrorNote, Field, Notice, inputClass } from '@/components/ui'

const EMPTY = {
  name: '',
  email: '',
  organization: '',
  category: 'question' as ContactTopic,
  message: '',
  website: '',
}

/** What went wrong, in plain words. The API's 400 already says what to fix. */
function problem(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400) return e.message
    if (e.status === 429)
      return 'Too many messages from here; please wait a few minutes and try again.'
    if (e.status === 503) return "The form isn't available right now; please try again later."
  }
  return "Your message didn't go through; please try again."
}

/**
 * Write to the team without an email client: POST /api/contact, the API's one public form, sent without a
 * Clerk token so it works signed out. `website` is a honeypot, out of sight and out of the tab order and the
 * accessibility tree, so only a bot fills it in. Signed in, the name and email start filled in. `page` (a path, from the 404 page) is shown read-only and sent along.
 */
export function ContactForm({
  initialMessage = '',
  initialCategory = 'question',
  page,
}: {
  initialMessage?: string
  initialCategory?: ContactTopic
  page?: string
}) {
  // Signed in, the name and email come from the account; the person can still change them.
  const { name, email } = useSession()
  const [form, setForm] = useState({
    ...EMPTY,
    name,
    email,
    category: initialCategory,
    message: initialMessage,
  })
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set =
    (k: keyof typeof EMPTY) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiFetch<void>('/contact', null, {
        method: 'POST',
        body: JSON.stringify({ ...form, page }),
      })
      setSent(true)
      setForm(EMPTY)
    } catch (err) {
      setError(problem(err))
    } finally {
      setBusy(false)
    }
  }

  if (sent) return <Notice tone="ok">Thanks, we'll be in touch.</Notice>
  return (
    <Card>
      <form className="grid gap-4" onSubmit={submit}>
        <ErrorNote message={error} />
        <Field label="Name" required>
          <input
            className={inputClass}
            value={form.name}
            onChange={set('name')}
            maxLength={120}
            autoComplete="name"
            required
          />
        </Field>
        <Field label="Email" required>
          <input
            className={inputClass}
            type="email"
            value={form.email}
            onChange={set('email')}
            maxLength={254}
            autoComplete="email"
            required
          />
        </Field>
        <Field label="Organization">
          <input
            className={inputClass}
            value={form.organization}
            onChange={set('organization')}
            maxLength={160}
            autoComplete="organization"
          />
        </Field>
        <Field label="Topic" required>
          <select className={inputClass} value={form.category} onChange={set('category')} required>
            {CONTACT_TOPICS.map((t) => (
              <option key={t} value={t}>
                {CONTACT_TOPIC_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        {page && (
          <p className="text-sm">
            <span className="font-bold">About:</span> <span className="ad-mono">{page}</span>
          </p>
        )}
        <Field label="Message" required>
          <textarea
            className={inputClass}
            rows={6}
            value={form.message}
            onChange={set('message')}
            maxLength={4000}
            required
          />
        </Field>
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '-10000px',
            width: 1,
            height: 1,
            overflow: 'hidden',
          }}
        >
          <input
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={form.website}
            onChange={set('website')}
          />
        </div>
        <div className="flex justify-end">
          <Button kind="primary" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send message'}
          </Button>
        </div>
      </form>
    </Card>
  )
}
