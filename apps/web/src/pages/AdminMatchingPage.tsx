import { useState } from 'react'
import type { ExpenseMatchingChangeDto, PayrollSettingChangeDto } from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { Card, Empty, ErrorNote } from '@/components/ui'
import { ExpenseMatchingSection } from '@/pages/AdminExpenseMatchingPage'
import { HighlightsSection } from '@/pages/AdminHighlightsPage'
import { MatchStatsSection } from '@/pages/AdminMatchStatsPage'
import { PayrollReadingSection } from '@/pages/AdminPayrollReadingPage'
import { AdminToolHead } from '@/pages/AdminPage'

/**
 * Admin tools → File Matching (owner's decision, 2026-10-19): one page for the payroll and receipt matchers. First how
 * they are running (statistics, every matcher), then how payroll files are read (the words and day windows) and what is
 * highlighted on payroll proof, then the day windows the books' bills are matched to their proof by, then every change
 * to those settings, newest first.
 */
export function AdminMatchingPage() {
  // Each save changes the history, so it is read again.
  const [version, setVersion] = useState(0)
  const saved = () => setVersion((v) => v + 1)
  return (
    <>
      <AdminToolHead to="/admin/matching" />
      <div className="grid gap-6">
        <section className="grid gap-3" aria-label="Statistics">
          <h2 className="ad-group-title">Statistics</h2>
          <MatchStatsSection />
        </section>
        <section className="grid gap-3" aria-label="Configuration">
          <h2 className="ad-group-title">Configuration</h2>
          <PayrollReadingSection onSaved={saved} />
          <HighlightsSection onSaved={saved} />
          <ExpenseMatchingSection onSaved={saved} />
          <SettingsHistory key={version} />
        </section>
      </div>
    </>
  )
}

/** Every save of the configuration: when, who, and what it changed, in words. */
function SettingsHistory() {
  const payroll = useLoad<PayrollSettingChangeDto[]>('/admin/payroll-reading/history')
  const expenses = useLoad<ExpenseMatchingChangeDto[]>('/admin/expense-matching/history')
  const error = payroll.error ?? expenses.error
  const data =
    payroll.data && expenses.data
      ? [...payroll.data, ...expenses.data].sort((a, b) => b.changedAt.localeCompare(a.changedAt))
      : null
  return (
    <Card title="Change history">
      <ErrorNote message={error} />
      {!data && !error && <Empty>Loading…</Empty>}
      {data && data.length === 0 && (
        <Empty>Nothing changed yet: every setting is as the app ships it.</Empty>
      )}
      {data && data.length > 0 && (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Setting</th>
                <th>What changed</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c, i) => (
                <tr key={`${c.changedAt}-${i}`}>
                  <td className="whitespace-nowrap">
                    {shortDate(c.changedAt)}
                    <span className="ad-table-sub">
                      {new Date(c.changedAt).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  </td>
                  <td className="ad-mono text-xs">{c.changedByEmail ?? 'An admin'}</td>
                  <td className="whitespace-nowrap">
                    {c.part === 'reading'
                      ? 'Payroll reading'
                      : c.part === 'expenses'
                        ? 'Expense matching'
                        : 'Proof highlighting'}
                  </td>
                  <td className="text-sm">
                    {c.changes.map((line) => (
                      <span key={line} className="block">
                        {line}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
