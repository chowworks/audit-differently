import { Injectable } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import {
  DEFAULT_HIGHLIGHTS,
  PAYROLL_BUDGET_KINDS,
  PAYROLL_BUDGET_KIND_LABELS,
  payrollPlace,
  type DocumentPurpose,
  type HighlightField,
  type PayrollBudgetKind,
  type ReportLine,
} from '@ad/types'
import { PrismaService } from '../prisma/prisma.service'
import {
  countedTwice,
  countsOnBudget,
  holdsPayroll,
  participantPaySpend,
  PAYROLL_KIND_OF_COVER,
  payrollCovers,
  payrollRowKind,
} from '../reports/report-lines'
import { booksBillsOf, runRules, type Finding, type RuleMonth, type RuleProof } from './rules'

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/** A proof link as the rules read it: its purpose, its file's kind and the words highlighted on it. */
const proofOf = (d: {
  purpose: string
  marks: unknown
  payRun?: boolean
  document: { kind: string }
}): RuleProof => ({
  purpose: d.purpose as DocumentPurpose,
  kind: d.document.kind,
  payRun: d.payRun === true,
  words: (Array.isArray(d.marks) ? (d.marks as { text?: unknown }[]) : [])
    .map((m) => m.text)
    .filter((t): t is string => typeof t === 'string'),
})

/** What the platform highlights on each kind of payroll proof: the newest setting per kind, else the defaults. */
export async function highlightsNow(
  prisma: PrismaClient
): Promise<Record<string, HighlightField[]>> {
  const rows = await prisma.highlightSetting.findMany({ orderBy: { changedAt: 'desc' } })
  const out: Record<string, HighlightField[]> = { ...DEFAULT_HIGHLIGHTS }
  for (const kind of Object.keys(DEFAULT_HIGHLIGHTS))
    out[kind] = (rows.find((r) => r.kind === kind)?.fields as HighlightField[]) ?? out[kind]!
  return out
}

/** Runs the rules over a month and stores the findings as Check rows (source 'rule'). */
@Injectable()
export class ChecksService {
  constructor(private readonly prisma: PrismaService) {}

  refresh(reportId: string): Promise<Finding[]> {
    return refreshChecks(this.prisma, reportId)
  }

  /** What the rules find in the month as it stands, without storing it: to compare with what a change leaves. */
  findings(reportId: string): Promise<Finding[]> {
    return findingsOf(this.prisma, reportId)
  }
}

/** The same, on any client: the seed uses it as the owner. */
export async function refreshChecks(prisma: PrismaClient, reportId: string): Promise<Finding[]> {
  const findings = await findingsOf(prisma, reportId)
  await prisma.$transaction([
    prisma.check.deleteMany({ where: { monthlyReportId: reportId, source: 'rule' } }),
    prisma.check.createMany({
      data: findings.map((f) => ({
        monthlyReportId: reportId,
        expenseId: f.expenseId ?? null,
        wexPaymentId: f.wexPaymentId ?? null,
        participantId: f.participantId ?? null,
        code: f.code,
        severity: f.severity,
        source: 'rule',
        message: f.message,
      })),
    }),
  ])
  return findings
}

/**
 * The kinds of payroll a month has (staff lines or books' payroll rows, participants' payments) whose budget line is
 * unclear on its engagement (payroll budget line items, #138): they count on no line until someone chooses.
 */
async function payrollUnclearOf(
  prisma: PrismaClient,
  report: {
    engagementId: string
    engagement: {
      name: string
      workspaceId: string
      workspace: { name: string }
      budgetLines: { name: string; reportLine: string }[]
    }
    expenses: { payrollKey: string | null; payrollKind: string | null }[]
    wexPayments: unknown[]
  }
): Promise<{ label: string; choices: string[]; engagement: string; workspace: string }[]> {
  // A staff line Save wrote from payroll details says its kind in its key (`staff:<id>:<run end>:pay|taxes`,
  // `participants:<run end>:taxes`); a books' payroll row says it in payrollKind.
  const keyKind = (key: string | null): PayrollBudgetKind | null =>
    !key
      ? null
      : key.startsWith('participants:')
        ? 'participant-taxes'
        : key.startsWith('staff:')
          ? key.endsWith(':taxes')
            ? 'staff-taxes'
            : 'staff-pay'
          : null
  const has = (k: PayrollBudgetKind) =>
    (k === 'participant-pay' && report.wexPayments.length > 0) ||
    report.expenses.some((e) => e.payrollKind === k || keyKind(e.payrollKey) === k)
  const kinds = PAYROLL_BUDGET_KINDS.filter(has)
  if (!kinds.length) return []
  const rows = await prisma.lineAlias.findMany({
    where: {
      workspaceId: report.engagement.workspaceId,
      list: 'payroll',
      OR: [{ engagementId: null }, { engagementId: report.engagementId }],
    },
    select: { name: true, engagementId: true, budgetLineName: true, unallowable: true },
  })
  const entries = rows.map((r) => ({
    kind: r.name as PayrollBudgetKind,
    engagementId: r.engagementId,
    budgetLineName: r.unallowable ? null : r.budgetLineName,
  }))
  return kinds.flatMap((k) => {
    const p = payrollPlace(k, report.engagementId, entries, report.engagement.budgetLines)
    return p.by === 'unclear'
      ? [
          {
            label: PAYROLL_BUDGET_KIND_LABELS[k],
            choices: p.choices.map((l) => l.name),
            engagement: report.engagement.name,
            workspace: report.engagement.workspace.name,
          },
        ]
      : []
  })
}

async function findingsOf(prisma: PrismaClient, reportId: string): Promise<Finding[]> {
  {
    const report = await prisma.monthlyReport.findUniqueOrThrow({
      where: { id: reportId },
      include: {
        engagement: { include: { budgetLines: true, workspace: { select: { name: true } } } },
        expenses: { include: { documents: { include: { document: { select: { kind: true } } } } } },
        wexPayments: {
          include: {
            participant: { select: { displayName: true } },
            documents: { include: { document: { select: { kind: true } } } },
          },
        },
      },
    })
    const earlier = await prisma.expense.findMany({
      where: {
        engagementId: report.engagementId,
        monthlyReport: { period: { lt: report.period } },
      },
      select: {
        id: true,
        vendor: true,
        totalCost: true,
        date: true,
        reportLine: true,
        budgetLineId: true,
        allocatedAmount: true,
        monthlyReportId: true,
        payrollKey: true,
        payrollKind: true,
        account: true,
        memo: true,
      },
    })
    const wexByMonth = await prisma.wexPayment.groupBy({
      by: ['monthlyReportId'],
      where: {
        monthlyReport: { engagementId: report.engagementId, period: { lt: report.period } },
      },
      _sum: { grossAmount: true },
      _count: { _all: true },
    })
    // A books' payroll transaction stops counting once the match covers its kind of payroll on its month: it is then
    // kept for reconciliation, neither spent on the budget nor checked as a line of its own.
    const covers = payrollCovers(
      [...earlier, ...report.expenses.map((e) => ({ ...e, monthlyReportId: report.id }))],
      new Map([
        ...wexByMonth.map((g) => [g.monthlyReportId, g._count._all] as const),
        [report.id, report.wexPayments.length] as const,
      ]),
      () => holdsPayroll(report.engagement.budgetLines, 'participant-pay')
    )
    const counted = earlier.filter((e) => countsOnBudget(e, covers.get(e.monthlyReportId)))
    const wexBefore = wexByMonth.reduce((t, g) => t + Number(g._sum.grossAmount ?? 0), 0)
    const budget: Partial<Record<ReportLine, number>> = {}
    for (const b of report.engagement.budgetLines)
      budget[b.reportLine as ReportLine] =
        (budget[b.reportLine as ReportLine] ?? 0) + Number(b.amount)
    const previouslyBilled: Partial<Record<ReportLine, number>> = {}
    for (const e of counted)
      previouslyBilled[e.reportLine as ReportLine] =
        (previouslyBilled[e.reportLine as ReportLine] ?? 0) + Number(e.allocatedAmount)
    const month: RuleMonth = {
      period: report.period,
      // A month exists only once the contract period is set (engagements.service), so these are present.
      contractStart: isoDate(report.engagement.periodStart ?? report.dueDate),
      contractEnd: isoDate(report.engagement.periodEnd ?? report.dueDate),
      dueDay: report.engagement.reportDueDay,
      budget,
      previouslyBilled,
      budgetLines: report.engagement.budgetLines.map((b) => ({
        id: b.id,
        name: b.name,
        amount: Number(b.amount),
        previouslyBilled: [...counted, ...participantPaySpend([b], wexBefore)]
          .filter((e) => e.budgetLineId === b.id)
          .reduce((t, e) => t + Number(e.allocatedAmount), 0),
        // The participants' pay this month, when this line holds it.
        alsoNow: participantPaySpend(
          [b],
          report.wexPayments.reduce((t, w) => t + Number(w.grossAmount), 0)
        )[0]?.allocatedAmount,
      })),
      submittedAt: report.submittedAt?.toISOString() ?? null,
      expenses: report.expenses
        .filter((e) => countsOnBudget(e, covers.get(report.id)))
        .map((e) => ({
          id: e.id,
          itemNumber: e.itemNumber,
          date: isoDate(e.date),
          vendor: e.vendor,
          memo: e.memo,
          totalCost: Number(e.totalCost),
          allocatedAmount: Number(e.allocatedAmount),
          allocationType: e.allocationType as 'direct' | 'payroll' | 'usage',
          reportLine: e.reportLine as ReportLine,
          budgetLineId: e.budgetLineId,
          // The match's own line, or a books' payroll transaction that still counts: proved as payroll.
          fromPayroll: !!e.payrollKey || !!e.payrollKind,
          fromBooks: !!e.booksKey,
          ...booksBillsOf(e.booksBills),
          shareOfRun: !!e.payrollKey,
          countedTwice: countedTwice(e, covers.get(report.id))
            ? PAYROLL_BUDGET_KIND_LABELS[
                PAYROLL_KIND_OF_COVER[payrollRowKind(e)] as PayrollBudgetKind
              ].toLowerCase()
            : null,
          documents: e.documents.map((d) => d.purpose as DocumentPurpose),
          proofs: e.documents.map(proofOf),
        })),
      wexPayments: report.wexPayments.map((w) => ({
        id: w.id,
        label: `${w.participant.displayName}, ${isoDate(w.payPeriodStart)} to ${isoDate(w.payPeriodEnd)}`,
        grossAmount: Number(w.grossAmount),
        start: isoDate(w.payPeriodStart),
        end: isoDate(w.payPeriodEnd),
        proofs: w.documents.map(proofOf),
      })),
      highlights: await highlightsNow(prisma),
      payrollUnclear: await payrollUnclearOf(prisma, report),
      earlierExpenses: earlier.map((e) => ({
        id: e.id,
        vendor: e.vendor,
        totalCost: Number(e.totalCost),
        date: isoDate(e.date),
      })),
    }
    return runRules(month)
  }
}
