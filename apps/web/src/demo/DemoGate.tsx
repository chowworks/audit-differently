import { useState } from 'react'
import { ApiError, apiFetch } from '@/services/api'
import { ErrorNote, Field, inputClass } from '@/components/ui'
import { ORG } from './data'
import { Tagline } from './TaglineSwitch'

/**
 * The demo's sign-up. A visitor leaves their name, work email, organization and role, sent to the team as a
 * contact message (POST /api/contact, topic "demo", page "/demo": nothing is stored by the app). This browser
 * then remembers it, so a returning visitor goes straight in. It is a marketing gate, not a security one.
 */

const KEY = 'ad-demo-unlocked'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const ROLES = [
  'CEO or executive director',
  'Finance, bookkeeping or accounting',
  'Program or grants manager',
  'Funder or state agency',
  'Auditor or CPA',
  'Something else',
]

export function isUnlocked(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function remember() {
  try {
    window.localStorage.setItem(KEY, '1')
  } catch {
    // Private windows may refuse storage: the visitor just signs up again next time.
  }
}

const EMPTY = { name: '', email: '', organization: '', role: '', website: '' }
type Form = typeof EMPTY
type Problems = Partial<Record<keyof Form, string>>

function check(f: Form): Problems {
  const p: Problems = {}
  if (!f.name.trim()) p.name = 'Enter your name.'
  if (!EMAIL.test(f.email.trim())) p.email = 'Enter a valid email address.'
  if (!f.organization.trim()) p.organization = 'Enter your organization.'
  if (!f.role) p.role = 'Choose your role.'
  return p
}

const LABELS: Record<string, string> = {
  name: 'Name',
  email: 'Work email',
  organization: 'Organization',
  role: 'Role',
}

export function DemoGate({ onUnlock }: { onUnlock: () => void }) {
  const [form, setForm] = useState(EMPTY)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problems = tried ? check(form) : {}
  const missing = Object.keys(problems)
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (Object.keys(check(form)).length) return
    setBusy(true)
    setError(null)
    try {
      await apiFetch<void>('/contact', null, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          organization: form.organization,
          category: 'demo',
          page: '/demo',
          message: `Opened the interactive demo.\nRole: ${form.role}`,
          website: form.website,
        }),
      })
    } catch (err) {
      // The API's own answer to what was typed is shown; anything else (busy, offline) lets the visitor in.
      if (err instanceof ApiError && err.status === 400) {
        setError(err.message)
        setBusy(false)
        return
      }
    }
    remember()
    onUnlock()
  }

  return (
    <section className="addm-gate">
      <div className="ad-wrap addm-gate-grid">
        <div className="addm-gate-pitch">
          <p className="addm-eyebrow addm-eyebrow-light">Interactive demo · 5 minutes</p>
          <h1>
            <Tagline />
          </h1>
          <p>
            Walk one month at {ORG}, a fictional training provider: the approved budget, the month’s
            uploads, every expense matched to its proof, unallowable costs caught, a forecast for
            every line, and the audit package built before anyone asks.
          </p>
          <ul>
            <li>✓ See how audit-ready a month is, in one number</li>
            <li>✓ Forecast which budget lines are heading over</li>
            <li>✓ Catch unallowable costs before they’re reported</li>
          </ul>
        </div>
        <form className="addm-gate-form" onSubmit={submit} noValidate>
          <h2>Open the demo</h2>
          <p className="addm-gate-sub">Tell us who you are and we’ll open it right away.</p>
          {missing.length > 0 && (
            <p className="addm-gate-missing" role="alert">
              Still to fix: {missing.map((k) => LABELS[k]).join(', ')}.
            </p>
          )}
          <ErrorNote message={error} />
          <Field label="Name" required error={problems.name}>
            <input
              className={inputClass}
              value={form.name}
              onChange={set('name')}
              maxLength={120}
              autoComplete="name"
            />
          </Field>
          <Field label="Work email" required error={problems.email}>
            <input
              className={inputClass}
              type="email"
              value={form.email}
              onChange={set('email')}
              maxLength={254}
              autoComplete="email"
            />
          </Field>
          <Field label="Organization" required error={problems.organization}>
            <input
              className={inputClass}
              value={form.organization}
              onChange={set('organization')}
              maxLength={160}
              autoComplete="organization"
            />
          </Field>
          <Field label="Role" required error={problems.role}>
            <select className={inputClass} value={form.role} onChange={set('role')}>
              <option value="">Choose one</option>
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          {/* A honeypot: out of sight and out of the tab order, so only a bot fills it in. */}
          <input
            className="addm-hp"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={form.website}
            onChange={set('website')}
            name="website"
          />
          <button type="submit" className="addm-btn addm-btn-lg addm-btn-full" disabled={busy}>
            {busy ? 'Opening…' : 'Open the demo →'}
          </button>
          <small className="addm-gate-fine">
            We use this only to follow up about Audit Differently. See our{' '}
            <a href="/privacy/">Privacy page</a>.
          </small>
        </form>
      </div>
    </section>
  )
}
