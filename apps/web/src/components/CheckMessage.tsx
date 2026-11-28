import { Link } from 'react-router-dom'

const PATH_START = 'Workspace Manager > '
const PATH_END = 'Map Payroll Budget Line Items'

/**
 * A check's words. A payroll line left unclear names the path to Map Payroll Budget Line Items (owner's wording,
 * 2026-11-28): that path is a link to the card on the workspace page.
 */
export function CheckMessage({
  code,
  message,
  workspaceId,
}: {
  code: string
  message: string
  workspaceId: string
}) {
  const from = message.indexOf(PATH_START)
  const to = message.indexOf(PATH_END, from)
  if (code !== 'payroll-line-unclear' || from < 0 || to < 0) return <>{message}</>
  const end = to + PATH_END.length
  return (
    <>
      {message.slice(0, from)}
      <Link to={`/workspaces/${workspaceId}#payroll-rollup`}>{message.slice(from, end)}</Link>
      {message.slice(end)}
    </>
  )
}
