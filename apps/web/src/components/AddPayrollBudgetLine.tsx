import { useState } from 'react'
import { PAYROLL_BUDGET_DEFAULTS, type EngagementDetail, type PayrollBudgetKind } from '@ad/types'
import { BudgetLineModal } from '@/components/BudgetLineModal'
import { useApi } from '@/hooks/useApi'

/**
 * Payroll no budget line takes, fixed from the payroll page: the engagement's line on the kind's report line (Staff
 * Salaries for staff pay, Staff Fringe Benefits for their taxes), opened with that payroll ticked; a new line when the
 * engagement has none on it. The page reads the month again once it is saved.
 */
export function AddPayrollBudgetLine({
  engagementId,
  kind,
  onAdded,
}: {
  engagementId: string
  kind: PayrollBudgetKind
  onAdded: () => void
}) {
  const api = useApi()
  const [engagement, setEngagement] = useState<EngagementDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    setError(null)
    try {
      const c = await api.get<EngagementDetail>(`/engagements/${engagementId}`)
      if (!c.canManage)
        setError('Only an owner or bookkeeper of the engagement changes its budget.')
      else setEngagement(c)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const reportLine = PAYROLL_BUDGET_DEFAULTS[kind][0]!
  const line = engagement?.budgetLines.find((b) => b.reportLine === reportLine)
  return (
    <>
      <button type="button" className="wpd-linkbtn" disabled={busy} onClick={() => void open()}>
        Add budget line →
      </button>
      {error && (
        <span className="ad-field-error" role="alert">
          {error}
        </span>
      )}
      {engagement && (
        <BudgetLineModal
          engagement={engagement}
          line={line}
          preset={{ reportLine, payroll: [kind] }}
          onClose={() => setEngagement(null)}
          onSaved={() => {
            setEngagement(null)
            onAdded()
          }}
        />
      )}
    </>
  )
}
