import { useState } from 'react'
import type {
  AccountMappingDto,
  BooksLineDto,
  WorkspaceExpensesDto,
  WorkspaceExpensesSavedDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { money, periodLabel } from '@/lib/format'
import { Button, Card, Chip, Empty, ErrorNote, Notice } from '@/components/ui'
import { engagementGroups, notOnEngagements, saveCounts, shareWords } from './workspace-expenses'
import './workspace-expenses.css'

const many = (n: number, one: string, more = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : more}`
const SKIP = 'skip'

/**
 * The month's expenses from the books (owner's decision, 2026-11-09): the step after payroll. Each line of the
 * accounting export in the month's files that is no one's pay, on the engagement its class is and the budget line its
 * account maps to, or why it is on none. Owners save; auditors read.
 */
export function WorkspaceExpenses({
  workspaceId,
  period,
  onDone,
}: {
  workspaceId: string
  period: string
  /** Saved, or left for later: back to the month's summary. */
  onDone: (saved: string | null) => void
}) {
  const api = useApi()
  const load = useLoad<WorkspaceExpensesDto>(`/workspaces/${workspaceId}/expenses/${period}`)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const d = load.data?.period === period ? load.data : null
  if (load.error) return <ErrorNote message={load.error} />
  if (!d) return <Empty>Reading the books…</Empty>
  const can = d.can.change
  const groups = engagementGroups(d.lines)
  const notOn = notOnEngagements(d.lines)
  const counts = saveCounts(d.lines)

  const changeMapping = async (m: AccountMappingDto, body: Record<string, unknown>) => {
    setError(null)
    setBusy('Saving the mapping…')
    try {
      await api.patch(`/workspaces/${workspaceId}/account-mappings/${m.id}`, body)
      await load.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const save = async () => {
    setError(null)
    setBusy('Saving the expenses…')
    try {
      const r = await api.post<WorkspaceExpensesSavedDto>(
        `/workspaces/${workspaceId}/expenses/${period}/save`
      )
      load.setData(r.expenses)
      onDone(
        `Saved the expenses for ${periodLabel(period)}: ${many(r.created, 'line')} added, ${many(r.updated, 'line')} changed, ${many(r.removed, 'line')} removed.`
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-4">
      <Card
        eyebrow={`Expenses · ${periodLabel(period)}`}
        title="Expenses from the books"
        aside={
          d.file ? <span className="text-sm text-soft">From {d.file.fileName}</span> : undefined
        }
      >
        {!d.file ? (
          <p className="text-soft">
            The month's files have no books export with expenses. Put the month's QuickBooks
            Transaction List with Splits in the zip's QuickBooks transactions folder.
          </p>
        ) : (
          <p className="text-sm">
            Every line of the books on an expense account that is no one's pay, routed to an
            engagement by its class and to a budget line by its account.{' '}
            <b>
              {many(
                groups.reduce((t, g) => t + g.lines.length, 0),
                'line'
              )}
            </b>{' '}
            on engagements,{' '}
            <b>
              {many(
                notOn.reduce((t, g) => t + g.lines.length, 0),
                'line'
              )}
            </b>{' '}
            on none, each with why.
          </p>
        )}
        {error && <ErrorNote message={error} />}
        {busy && <Notice tone="info">{busy}</Notice>}
      </Card>

      <Card title="Account mappings">
        {d.mappings.length === 0 ? (
          <p className="text-soft">
            No account mapping yet. Put each engagement's chart of accounts mapping (account number
            and the category it bills to) in the zip's <b>Account mapping</b> folder.
          </p>
        ) : (
          <div className="grid gap-3">
            {d.mappings.map((m) => {
              const e = d.engagements.find((x) => x.id === m.engagementId)
              return (
                <div key={m.id} className="wex-mapping">
                  <div className="wex-mapping-head">
                    <b>{m.fileName}</b>
                    {can ? (
                      <select
                        aria-label={`Engagement of ${m.fileName}`}
                        value={m.engagementId ?? ''}
                        disabled={!!busy}
                        onChange={(ev) => void changeMapping(m, { engagementId: ev.target.value })}
                      >
                        {!m.engagementId && <option value="">Choose its engagement…</option>}
                        {d.engagements.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>{m.engagementName ?? 'No engagement'}</span>
                    )}
                  </div>
                  {m.engagementId && (
                    <div className="ad-tablewrap">
                      <table className="ad-table">
                        <thead>
                          <tr>
                            <th>Category in the file</th>
                            <th className="ad-num">Accounts</th>
                            <th>Budget line</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.categories.map((c) => (
                            <tr key={c.category}>
                              <td>{c.category}</td>
                              <td className="ad-num">{c.accounts}</td>
                              <td>
                                {can ? (
                                  <select
                                    aria-label={`Budget line for ${c.category}`}
                                    value={c.chosen ? (c.budgetLineId ?? '') : ''}
                                    disabled={!!busy}
                                    onChange={(ev) =>
                                      void changeMapping(m, {
                                        category: c.category,
                                        budgetLineId: ev.target.value || null,
                                      })
                                    }
                                  >
                                    <option value="">
                                      {c.chosen || !c.budgetLineName
                                        ? c.chosen
                                          ? 'As the file says'
                                          : 'Choose a budget line…'
                                        : `${c.budgetLineName} (as the file says)`}
                                    </option>
                                    {e?.budgetLines.map((b) => (
                                      <option key={b.id} value={b.id}>
                                        {b.name}
                                      </option>
                                    ))}
                                    <option value={SKIP}>Not billed</option>
                                  </select>
                                ) : (
                                  (c.budgetLineName ??
                                  (c.budgetLineId === SKIP ? 'Not billed' : 'None'))
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {groups.map((g) => (
        <Card key={g.id} title={g.name} aside={<b>{money(g.total)}</b>}>
          <LineTable lines={g.lines} withLine />
        </Card>
      ))}

      {notOn.length > 0 && (
        <Card title="On no engagement" eyebrow="Every books line is here or above">
          <div className="grid gap-2">
            {notOn.map((n) => (
              <details key={n.status} className="wex-why">
                <summary>
                  <b>{n.label}</b> · {many(n.lines.length, 'line')} · {money(n.total)}
                </summary>
                <LineTable lines={n.lines} />
              </details>
            ))}
          </div>
        </Card>
      )}

      <div className="wex-actions">
        {can && d.file && (
          <Button
            kind="navy"
            disabled={!!busy || counts.add + counts.change === 0}
            onClick={() => void save()}
          >
            {counts.add + counts.change === 0
              ? 'Expenses saved'
              : `Save expenses (${many(counts.add, 'new line')}${counts.change ? `, ${many(counts.change, 'change')}` : ''})`}
          </Button>
        )}
        <Button kind="secondary" disabled={!!busy} onClick={() => onDone(null)}>
          {can ? 'Leave for later' : 'Back'}
        </Button>
      </div>
    </div>
  )
}

function LineTable({ lines, withLine = false }: { lines: BooksLineDto[]; withLine?: boolean }) {
  return (
    <div className="ad-tablewrap">
      <table className="ad-table wex-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Vendor</th>
            <th>Account</th>
            <th>{withLine ? 'Budget line' : 'Class'}</th>
            <th className="ad-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const share = shareWords(l, money)
            return (
              <tr key={l.key}>
                <td>{l.date}</td>
                <td>
                  <span className="font-semibold">{l.vendor}</span>
                  <span className="ad-table-sub">
                    {l.type} {l.transactionId}
                    {l.paidFrom
                      ? ` · paid from ${l.paidFrom.kind === 'card' ? 'a card' : 'the bank'}`
                      : ''}
                  </span>
                </td>
                <td>{l.account.split(':').pop()}</td>
                <td>
                  {withLine ? l.budgetLineName : l.className || '—'}
                  {share && <span className="ad-table-sub">{share}</span>}
                  {l.status === 'already-entered' && <Chip tone="muted">Already on the month</Chip>}
                  {l.saved === 'same' && <Chip tone="ok">Saved</Chip>}
                  {l.saved === 'changed' && <Chip tone="warn">Changed in the books</Chip>}
                </td>
                <td className="ad-num">{money(l.amount)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
