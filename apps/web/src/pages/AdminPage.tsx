import { Link } from 'react-router-dom'
import { Icon, type IconName } from '@/components/icons'

/**
 * The tools, in the order the landing page shows them. Each tool's page reads its header from here (AdminToolHead):
 * the tile's icon and title, `sub` (one line: what to do here) and `how` (the longer explanation, behind "How this
 * works"). A new tool adds an entry here and uses AdminToolHead and AdminHow (CLAUDE.md, "Admin tools").
 */
const TOOLS: {
  to: string
  icon: IconName
  title: string
  text: string
  sub: string
  how: string
}[] = [
  {
    to: '/admin/admins',
    icon: 'shield',
    title: 'Manage admins',
    text: 'Find a person and make them a platform admin, or take that away. Every change is kept.',
    sub: 'Make a person a platform admin, or take that away.',
    how: "Platform admins set up workspaces and their people; they never read a workspace's records. Nobody changes their own role, so the platform always keeps an admin, and there are at most 20. Every attempt is kept under Admin changes.",
  },
  {
    to: '/admin/workspaces',
    icon: 'building',
    title: 'Manage workspaces',
    text: 'Create a workspace for a customer with its first owner, and keep its people and lists.',
    sub: 'Set up a workspace for each customer, and keep its people and lists.',
    how: 'A new workspace names its first owner by email; they get it when they sign in. Open a workspace to rename it or change its people and lists. What a workspace records (its engagements, documents and access log) stays its own: nothing here opens it.',
  },
  {
    to: '/admin/email',
    icon: 'mail',
    title: 'Email administration',
    text: 'See emailed receipts that went nowhere or were refused or failed, run them again, and release old receipts addresses.',
    sub: "Emails that didn't get filed, and every receipts address used. Fix the cause, then run one again.",
    how: "An email shows here when it reached no workspace (an unknown address, a sender who couldn't be verified, or a failure before anyone knew whose it was), or when a workspace's email was refused or failed. You see who sent it, to which address and its subject, never its attachments. Run again puts it back in the queue; the page checks what became of it for a minute. Emails are removed 30 days after they arrive. Mail sent to a previously used receipts address isn't listed here: it's counted on that address under Previously used addresses.",
  },
  {
    to: '/admin/matching',
    icon: 'chart',
    title: 'File Matching',
    text: 'See how the payroll and receipt matchers run, and set how payroll files are read and what is highlighted on their proof.',
    sub: 'How the matchers run, and how payroll files are read, for every workspace.',
    how: 'Statistics count every payroll and receipt match. The configuration holds for every workspace, and every change is kept in its history.',
  },
]

const tool = (to: string) => TOOLS.find((t) => t.to === to)!

/**
 * Admin tools, for the platform admin (Clerk publicMetadata.role = admin): one tile per tool. Workspace level only:
 * no tool opens an engagement, a record or an access log.
 */
export function AdminPage() {
  return (
    <>
      <div className="ad-head">
        <div>
          <p className="ad-eyebrow">Platform admin</p>
          <h1 className="ad-h1">Admin tools</h1>
          <p className="ad-sub">
            Tools for running the platform. What a workspace records stays its own.
          </p>
        </div>
      </div>
      <div className="ad-tools">
        {TOOLS.map((t) => (
          <Link key={t.to} to={t.to} className="ad-tool">
            <span className="ad-tool-icon">
              <Icon name={t.icon} size={28} />
            </span>
            <span className="ad-tool-title">{t.title}</span>
            <span className="ad-tool-text">{t.text}</span>
            <span className="ad-tool-open">Open tool →</span>
          </Link>
        ))}
        <div className="ad-tool ad-tool-more">
          <span className="ad-tool-title">More tools coming</span>
          <span className="ad-tool-text">New platform tools will appear here.</span>
        </div>
      </div>
    </>
  )
}

/** A tool page's breadcrumb (Admin tools / the tool) and header: the tile's icon, the title and one line. */
export function AdminToolHead({ to }: { to: string }) {
  const t = tool(to)
  return (
    <>
      <AdminCrumbs tool={t.title} />
      <div className="ad-toolhead">
        <span className="ad-tool-icon">
          <Icon name={t.icon} size={28} />
        </span>
        <div>
          <h1 className="ad-h1">{t.title}</h1>
          <p className="ad-sub">{t.sub}</p>
        </div>
      </div>
    </>
  )
}

/**
 * The longer explanation of a tool, closed until asked for; it goes at the end of the tool's main card. A tool with a
 * second section (Email administration's receipts addresses) gives that section's own `text`.
 */
export function AdminHow({ to, text }: { to: string; text?: React.ReactNode }) {
  return (
    <details className="ad-toolhow">
      <summary>How this works</summary>
      {/* A string is one paragraph; anything else (a bold line and a list) is shown as it is. */}
      {text && typeof text !== 'string' ? text : <p>{text ?? tool(to).how}</p>}
    </details>
  )
}

/** Admin tools / the tool; inside a tool, the tool links to its page (`to`) and `here` names the page. */
export function AdminCrumbs({ tool, to, here }: { tool: string; to?: string; here?: string }) {
  return (
    <nav className="ad-crumbs" aria-label="Breadcrumb">
      <Link to="/admin">Admin tools</Link> /{' '}
      {to ? (
        <>
          <Link to={to}>{tool}</Link>
          {here && ` / ${here}`}
        </>
      ) : (
        tool
      )}
    </nav>
  )
}
