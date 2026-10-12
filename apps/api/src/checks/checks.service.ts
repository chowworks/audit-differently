import { Injectable } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import type { DocumentPurpose, ReportLine } from '@ad/types'
import { eligibilityItemsOf } from '../engagements/eligibility'
import { PrismaService } from '../prisma/prisma.service'
import { runRules, type Finding, type RuleMonth } from './rules'

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/** Runs the rules over a month and stores the findings as Check rows (source 'rule'). */
@Injectable()
export class ChecksService {
  constructor(private readonly prisma: PrismaService) {}

  refresh(reportId: string): Promise<Finding[]> {
    return refreshChecks(this.prisma, reportId)
  }
}

/** The same, on any client: the seed uses it as the owner. */
export async function refreshChecks(prisma: PrismaClient, reportId: string): Promise<Finding[]> {
  {
    const report = await prisma.monthlyReport.findUniqueOrThrow({
      where: { id: reportId },
      include: {
        engagement: {
          include: { budgetLines: true, participants: { include: { documents: true } } },
        },
        expenses: { include: { documents: true } },
        wexPayments: true,
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
    const paid = new Set(report.wexPayments.map((w) => w.participantId))
    const month: RuleMonth = {
      period: report.period,
      // A month exists only once the contract period is set (engagements.service), so these are present.
      contractStart: isoDate(report.engagement.periodStart ?? report.dueDate),
      contractEnd: isoDate(report.engagement.periodEnd ?? report.dueDate),
      dueDay: report.engagement.reportDueDay,
      budget,
      previouslyBilled,
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
        documents: e.documents.map((d) => d.purpose as DocumentPurpose),
      })),
      earlierExpenses: earlier.map((e) => ({
        id: e.id,
        vendor: e.vendor,
        totalCost: Number(e.totalCost),
        date: isoDate(e.date),
      })),
      requiredEligibilityItems: eligibilityItemsOf(report.engagement)
        .filter((i) => i.required)
        .map((i) => i.key),
      participants: report.engagement.participants.map((p) => ({
        id: p.id,
        participantId: p.participantId,
        displayName: p.displayName,
        eligibilityItems: p.documents.map((d) => d.purpose),
        paidThisMonth: paid.has(p.id),
      })),
    }
    const findings = runRules(month)
    await prisma.$transaction([
      prisma.check.deleteMany({ where: { monthlyReportId: reportId, source: 'rule' } }),
      prisma.check.createMany({
        data: findings.map((f) => ({
          monthlyReportId: reportId,
          expenseId: f.expenseId ?? null,
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
}
