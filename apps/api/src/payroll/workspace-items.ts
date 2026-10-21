import {
  PAYROLL_REPORT_LINES,
  type PayrollSlot,
  type ReportLine,
  type ReportStatus,
  type WorkspacePayrollItemDto,
  type WorkspacePayrollMonthDto,
} from '@ad/types'
import type { Caller } from '../core/caller'
import type { PrismaService } from '../prisma/prisma.service'
import { countsOnBudget, holdsPayroll, payrollCovers } from '../reports/report-lines'
import { slotsOf, type ProofItem } from './match-proof'

const day = (d: Date) => d.toISOString().slice(0, 10)

/** One proof link of an item: which document, as what, and its highlights. */
export interface ItemLink {
  documentId: string
  kind: string
  /** Its file's contents: the same file on another document is the same proof. */
  sha256: string
  purpose: string
  mark: unknown
  marks: unknown
  /** Made by the workspace payroll match; false for a person's link (never changed by matching again). */
  byMatch: boolean
  /** A bank line matched as the debit of the pay run that paid the item. */
  payRun: boolean
}

/** A payroll item of one engagement's month, with its month and the proofs already linked. */
export interface WorkspaceItem {
  target: 'expense' | 'wex'
  id: string
  /** How the access log names it: "expense ISY-12", "a work-experience payment". */
  subject: string
  proof: ProofItem
  month: WorkspacePayrollMonthDto & { period: string }
  links: ItemLink[]
  dto: WorkspacePayrollItemDto
  /** An expense line's report line; null for a work-experience payment. */
  reportLine: string | null
  /** A work-experience payment's participant (the row's id), the pay stub it was made from, and whether it was typed by hand first. */
  wex: { participantRowId: string; stubDocumentId: string | null; stubTookOver: boolean } | null
}

/** The proof a link is: its purpose and its file's kind (a payment by a pay stub or by a bank line). */
export function slotOfLink(l: Pick<ItemLink, 'purpose' | 'kind'>): PayrollSlot | null {
  if (l.purpose === 'timesheet') return 'timesheet'
  if (l.purpose === 'register') return 'register'
  if (l.purpose === 'payment' && l.kind === 'paystub') return 'stub'
  if (l.purpose === 'payment' && l.kind === 'bank-statement') return 'bank'
  return null
}

/** Whether the item already has this proof on file: a bank line needs its line marked. */
export function proved(links: ItemLink[], slot: PayrollSlot): boolean {
  if (slot === 'timesheet') return links.some((l) => l.purpose === 'timesheet')
  if (slot === 'register') return links.some((l) => l.purpose === 'register')
  if (slot === 'stub') return links.some((l) => l.purpose === 'payment' && l.kind === 'paystub')
  return links.some((l) => l.purpose === 'payment' && l.kind === 'bank-statement' && !!l.mark)
}

/**
 * Every payroll item of the workspace for the period: each engagement's month for it, its payroll expense lines and its
 * work-experience payments, with what is already linked to each. Read in the caller's own context (row-level
 * security), so a workspace they are not in gives nothing; `caller` null is trusted work (the sweeper's statistics).
 */
export async function workspaceItems(
  prisma: PrismaService,
  caller: Caller | null,
  workspaceId: string,
  period: string
): Promise<{ items: WorkspaceItem[]; months: WorkspacePayrollMonthDto[] }> {
  const rows = await prisma.monthlyReport.findMany({
    where: {
      workspaceId,
      period,
      ...(caller && !caller.workspaceIds.includes(workspaceId) ? { id: '-' } : {}),
    },
    orderBy: { engagement: { name: 'asc' } },
    include: {
      engagement: { select: { id: true, name: true } },
      expenses: {
        orderBy: [{ date: 'asc' }, { itemNumber: 'asc' }],
        include: { documents: { include: { document: { select: { kind: true, sha256: true } } } } },
      },
      wexPayments: {
        orderBy: { payPeriodStart: 'asc' },
        include: {
          participant: { select: { id: true, displayName: true, participantId: true } },
          documents: { include: { document: { select: { kind: true, sha256: true } } } },
        },
      },
    },
  })
  // A books' payroll transaction the match covers on its month is the same pay, kept for the reconciliation alone: not
  // an item to prove (owner's decision, 2026-10-20), as it is hidden on the month page.
  const budgetLines = rows.length
    ? await prisma.budgetLine.findMany({
        where: { engagementId: { in: [...new Set(rows.map((r) => r.engagementId))] } },
        select: { engagementId: true, payroll: true },
      })
    : []
  const engagementOf = new Map(rows.map((r) => [r.id, r.engagementId]))
  const covers = payrollCovers(
    rows.flatMap((r) => r.expenses),
    new Map(rows.map((r) => [r.id, r.wexPayments.length])),
    (id) =>
      holdsPayroll(
        budgetLines.filter((l) => l.engagementId === engagementOf.get(id)),
        'participant-pay'
      )
  )
  const months = rows.map((r) => ({
    reportId: r.id,
    engagementId: r.engagementId,
    engagementName: r.engagement.name,
    status: r.status as ReportStatus,
  }))
  const items: WorkspaceItem[] = []
  for (const [i, r] of rows.entries()) {
    const month = { ...months[i]!, period: r.period }
    const base = {
      engagementId: r.engagementId,
      engagementName: r.engagement.name,
      reportId: r.id,
      period: r.period,
      monthStatus: r.status as ReportStatus,
    }
    const linksOf = (
      ds: {
        documentId: string
        purpose: string
        mark: unknown
        marks: unknown
        byMatch?: boolean
        payRun?: boolean
        document: { kind: string; sha256: string }
      }[]
    ): ItemLink[] =>
      ds.map((d) => ({
        documentId: d.documentId,
        kind: d.document.kind,
        sha256: d.document.sha256,
        purpose: d.purpose,
        mark: d.mark,
        marks: d.marks,
        byMatch: d.byMatch === true,
        payRun: d.payRun === true,
      }))
    for (const e of r.expenses) {
      if (!PAYROLL_REPORT_LINES.has(e.reportLine as ReportLine)) continue
      if (e.payrollKind && !countsOnBudget(e, covers.get(r.id))) continue
      const proof: ProofItem = {
        target: 'expense',
        id: e.id,
        kind: 'staff',
        name: null,
        amount: Number(e.totalCost),
        start: day(e.date),
        end: day(e.date),
        month: r.period,
      }
      const links = linksOf(e.documents)
      items.push({
        target: 'expense',
        id: e.id,
        subject: `expense ${e.itemNumber}`,
        proof,
        month,
        links,
        reportLine: e.reportLine,
        wex: null,
        dto: {
          ...base,
          target: 'expense',
          id: e.id,
          kind: 'staff',
          title: `Expense ${e.itemNumber} ${e.vendor}`,
          sub: e.reportLine,
          start: proof.start,
          end: proof.end,
          amount: proof.amount,
          proved: slotsOf(proof).filter((s) => proved(links, s)),
        },
      })
    }
    for (const w of r.wexPayments) {
      const proof: ProofItem = {
        target: 'wex',
        id: w.id,
        kind: 'participant',
        name: w.participant.displayName,
        amount: Number(w.grossAmount),
        start: day(w.payPeriodStart),
        end: day(w.payPeriodEnd),
        month: r.period,
      }
      const links = linksOf(w.documents)
      items.push({
        target: 'wex',
        id: w.id,
        subject: 'a work-experience payment',
        proof,
        month,
        links,
        reportLine: null,
        wex: {
          participantRowId: w.participant.id,
          stubDocumentId: w.stubDocumentId,
          stubTookOver: w.stubTookOver === true,
        },
        dto: {
          ...base,
          target: 'wex',
          id: w.id,
          kind: 'participant',
          title: `${w.participant.displayName}'s work-experience pay`,
          sub: w.participant.participantId,
          start: proof.start,
          end: proof.end,
          amount: proof.amount,
          proved: slotsOf(proof).filter((s) => proved(links, s)),
        },
      })
    }
  }
  return { items, months }
}
