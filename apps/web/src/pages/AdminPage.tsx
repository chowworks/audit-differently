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
    text: 'See emailed receipts that went nowhere or were refused or failed, and run them again.',
    sub: "Emails that didn't get filed. Fix the cause, then run one again.",
    how: "An email shows here when it reached no workspace (an unknown address, a sender who couldn't be verified, or a failure before anyone knew whose it was), or when a workspace's email was refused or failed. You see who sent it, to which address and its subject, never its attachments. Run again puts it back in the queue; the page checks what became of it for a minute. Emails are removed 30 days after they arrive.",
  },
  {
    to: '/admin/highlights',
    icon: 'sliders',
    title: 'Payroll proof highlighting',
    text: 'Choose what the auditor sees highlighted on each payroll proof: the name, the pay period, the amount and more.',
    sub: "Choose what's highlighted on each kind of payroll proof, for every workspace.",
    how: "When a payroll item is matched to its proof, these words are highlighted on that item's own copy of the file, so the auditor sees exactly what proves it. The same choice holds for every workspace. Each tick saves at once and is kept, with who made it and when; a proof type never changed uses the defaults. What a matched file can't show is left out, never guessed.",
  },
  {
    to: '/admin/match-stats',
    icon: 'chart',
    title: 'Matching statistics',
    text: 'See how often the payroll and receipt matchers run, how long they take and how much they match.',
    sub: 'How the matchers are running, across every workspace.',
    how: "A row is kept each time a match ends: a payroll match when it is saved, discarded or left for a day, a receipt upload when it finishes or fails, and an emailed receipt each time it is filed or a try fails (a retry is a run of its own). It keeps who started it, the workspace, how many files were uploaded and how big, how long it took (and how much of that was reading), and how many were matched, guessed or missing. It never keeps a file's name, a person's or vendor's name, an amount or which record it was. Match rate is what was found sure out of everything that needed a match. Days are UTC.",
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

/** The longer explanation of a tool, closed until asked for; it goes at the end of the tool's main card. */
export function AdminHow({ to }: { to: string }) {
  return (
    <details className="ad-toolhow">
      <summary>How this works</summary>
      <p>{tool(to).how}</p>
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
