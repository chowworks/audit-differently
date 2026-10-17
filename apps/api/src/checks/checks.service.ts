import { Injectable } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import {
  DEFAULT_HIGHLIGHTS,
  type DocumentPurpose,
  type HighlightField,
  type ReportLine,
} from '@ad/types'
import { PrismaService } from '../prisma/prisma.service'
import { runRules, type Finding, type RuleMonth, type RuleProof } from './rules'

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/** A proof link as the rules read it: its purpose, its file's kind and the words highlighted on it. */
const proofOf = (d: {
  purpose: string
  marks: unknown
  document: { kind: string }
}): RuleProof => ({
  purpose: d.purpose as DocumentPurpose,
  kind: d.document.kind,
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

async function findingsOf(prisma: PrismaClient, reportId: string): Promise<Finding[]> {
  {
    const report = await prisma.monthlyReport.findUniqueOrThrow({
      where: { id: reportId },
      include: {
        engagement: { include: { budgetLines: true } },
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
      },
    })
    const budget: Partial<Record<ReportLine, number>> = {}
    for (const b of report.engagement.budgetLines)
      budget[b.reportLine as ReportLine] =
        (budget[b.reportLine as ReportLine] ?? 0) + Number(b.amount)
    const previouslyBilled: Partial<Record<ReportLine, number>> = {}
    for (const e of earlier)
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
        previouslyBilled: earlier
          .filter((e) => e.budgetLineId === b.id)
          .reduce((t, e) => t + Number(e.allocatedAmount), 0),
      })),
      submittedAt: report.submittedAt?.toISOString() ?? null,
      expenses: report.expenses.map((e) => ({
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
