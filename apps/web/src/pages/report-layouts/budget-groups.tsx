/*
 * Expenses & Proof and Payroll & Proof in budget-line sections (Stephanie's suggestion, owner's choice 2026-11-17), on
 * the month page and inside each engagement on Month End Close: one heading per budget line with its count, total and
 * how many are proved, folded and opened on a click like an engagement's heading.
 */
import { Fragment, useState, type ReactNode } from 'react'
import type { ReportDetail } from '@ad/types'
import { money } from '@/lib/format'
import './budget-groups.css'

export interface LineGroup<T> {
  key: string
  label: string
  /** The rows the filters leave. */
  rows: T[]
  /** Every row on the line: the heading counts them all, whatever the filter. */
  all: T[]
}

/** Budget line keys a row may have besides a budget line's id. */
export const NO_LINE = 'none'
export const WEX_LINE = 'wex-payments'
export const OTHER_LINE = 'other'

/**
 * The rows by budget line, in the budget's own order (as the budget tile lists them): what needs a budget line first,
 * then each line, then participants paid and anything with no line of its own. Lines with no row shown are left out.
 */
export function lineGroups<T>(
  r: ReportDetail | null,
  shown: T[],
  all: T[],
  keyOf: (t: T) => string
): LineGroup<T>[] {
  const order = [NO_LINE, ...(r?.budgetLines ?? []).map((b) => b.id), WEX_LINE, OTHER_LINE]
  const keys = [...new Set(all.map(keyOf))].sort((a, b) => rank(order, a) - rank(order, b))
  return keys
    .map((key) => ({
      key,
      label: labelOf(r, key),
      rows: shown.filter((t) => keyOf(t) === key),
      all: all.filter((t) => keyOf(t) === key),
    }))
    .filter((g) => g.rows.length > 0)
}

const rank = (order: string[], key: string) => {
  const i = order.indexOf(key)
  return i < 0 ? order.length - 2 : i
}

function labelOf(r: ReportDetail | null, key: string) {
  if (key === NO_LINE) return 'Needs a budget line'
  if (key === WEX_LINE) return 'Work experience payments'
  if (key === OTHER_LINE) return 'Alerts'
  return r?.budgetLines.find((b) => b.id === key)?.name ?? 'Budget line'
}

/** A grid's rows in budget-line sections, each under its heading; a click on the heading folds or opens the line. */
export function LineSections<T>({
  groups,
  columns,
  noun,
  amountOf,
  provedOf,
  render,
  rowKey,
}: {
  groups: LineGroup<T>[]
  columns: number
  noun: [string, string]
  amountOf: (t: T) => number
  provedOf: (t: T) => boolean
  render: (t: T) => ReactNode
  rowKey: (t: T) => string
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const flip = (key: string) =>
    setClosed((c) => {
      const n = new Set(c)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  return (
    <>
      {groups.map((g) => {
        const isClosed = closed.has(g.key)
        const count = `${g.all.length} ${g.all.length === 1 ? noun[0] : noun[1]}`
        // The alerts on an engagement's payroll (two files that disagree, a run the books differ on) carry no amount.
        const meta =
          g.key === OTHER_LINE
            ? count
            : `${count} · ${money(g.all.reduce((s, t) => s + amountOf(t), 0))} · ${
                g.all.filter(provedOf).length
              } of ${g.all.length} proved`
        return (
          <Fragment key={g.key}>
            <tr
              className={`rl-bl-head${g.key === NO_LINE ? ' rl-bl-none' : ''}`}
              aria-expanded={!isClosed}
              onClick={() => flip(g.key)}
            >
              <td colSpan={columns}>
                <span className="rl-bl-caret" aria-hidden>
                  {isClosed ? '▸' : '▾'}
                </span>
                <span className="rl-bl-name">{g.label}</span>
                <span className="rl-bl-meta">
                  {meta}
                  {g.rows.length < g.all.length ? ` · ${g.rows.length} shown` : ''}
                </span>
              </td>
            </tr>
            {!isClosed && g.rows.map((t) => <Fragment key={rowKey(t)}>{render(t)}</Fragment>)}
          </Fragment>
        )
      })}
    </>
  )
}
