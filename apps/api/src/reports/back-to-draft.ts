import { ConflictException } from '@nestjs/common'
import type { MonthlyReport, Prisma } from '@prisma/client'
import type { Actor, LogEntry } from '../core/access-log.service'
import { staffName } from '../core/caller'
import { changesOf, monthName, type Fields } from '../core/changes'
import { NothingChanged } from '../documents/link'
import { currentSignedCopy, dayWords } from './reopenings'

/**
 * A month's report, labelled as the month's page and its month-end closing form label it: its status and dates by
 * value; the people who prepared it and approved its closing, and the free-text note and reason, by name alone.
 */
export const REPORT_FIELDS: Fields = {
  status: { label: 'Status', show: 'text' },
  submittedAt: { label: 'Submitted on', show: 'date' },
  preparedByName: { label: 'Prepared by' },
  authorizedByName: { label: 'Approved by' },
  authorizedAt: { label: 'Approved on', show: 'date' },
  closingNote: { label: 'Note' },
  sentBackReason: { label: 'Why it was sent back' },
  sentBackAt: { label: 'Sent back on', show: 'date' },
  sentBackByEmail: { label: 'Sent back by', show: 'text' },
  editsRequestedAt: { label: 'Edits asked for on', show: 'date' },
  editsRequestedByEmail: { label: 'Edits asked for by', show: 'text' },
  editsRequestComment: { label: 'What needs editing' },
}

/** What reopening a submitted month undoes: a draft again, without its submission or its closing approval. */
export const REOPENED = {
  status: 'draft',
  submittedAt: null,
  authorizedByName: null,
  authorizedAt: null,
  closingNote: null,
  sentBackReason: null,
  sentBackAt: null,
  sentBackByEmail: null,
}

/**
 * Keeps for good, in a ReportReopening row on `tx`, what reopening the submitted month `before` undoes: the
 * submission's date, the closing's approval and the signed copy that was submitted (never replaced or removed after
 * this). The Reopen to correct button and a change that sends months back both write it.
 */
export async function recordReopening(
  tx: Prisma.TransactionClient,
  before: MonthlyReport,
  actor: Actor,
  reason: string
) {
  if (!before.submittedAt)
    throw new ConflictException(`${monthName(before.period)} has no submission to reopen`)
  const [latest, signedCopies] = await Promise.all([
    tx.reportReopening.findFirst({
      where: { monthlyReportId: before.id },
      orderBy: { reopenedAt: 'desc' },
    }),
    tx.document.findMany({
      where: { engagementId: before.engagementId, period: before.period, kind: 'signed-report' },
    }),
  ])
  const signed = currentSignedCopy(signedCopies, before.period, latest?.reopenedAt)
  return tx.reportReopening.create({
    data: {
      monthlyReportId: before.id,
      reopenedById: actor.userId,
      reopenedByEmail: staffName(actor),
      reason,
      submittedAt: before.submittedAt,
      approvedByName: before.authorizedByName,
      approvedAt: before.authorizedAt,
      signedDocumentId: signed?.id ?? null,
    },
  })
}

/** What changed, in the words the month's page and the access log use after "because". */
export const BECAUSE = {
  budget: 'the approved budget changed',
  participants: "a participant's eligibility file changed",
} as const

/** A month a change put back to draft, and what it was before. */
export interface BackToDraft {
  id: string
  period: string
  was: 'closed' | 'submitted'
}

/**
 * Puts one closed or submitted month back to draft because `because` changed, inside the transaction of that change
 * (the owner's decisions, 2026-10-16: a month that suffered a modification is reopened, submitted ones included). A
 * closed month is sent back as the Send back button does it, the reason kept on the month; a submitted month is
 * reopened as Reopen to correct does it, with its ReportReopening row. Either way its closing is approved and it is
 * sent again. NothingChanged if the month is a draft. Answers the month and its line, in the person's name.
 */
export async function backToDraft(
  tx: Prisma.TransactionClient,
  actor: Actor,
  reportId: string,
  engagement: { name: string; workspaceId: string },
  because: string
): Promise<BackToDraft & { entry: LogEntry }> {
  const before = await tx.monthlyReport.findFirst({ where: { id: reportId } })
  if (!before || (before.status !== 'closed' && before.status !== 'submitted'))
    throw new NothingChanged()
  const was = before.status
  const today = dayWords(new Date())
  const month = `${monthName(before.period)} of ${engagement.name}`
  let data: Record<string, unknown>
  let description: string
  const also = []
  if (was === 'closed') {
    data = {
      status: 'draft',
      authorizedByName: null,
      authorizedAt: null,
      closingNote: null,
      sentBackReason: `Sent back because ${because} on ${today}.`,
      sentBackAt: new Date(),
      sentBackByEmail: staffName(actor),
    }
    description = `Sent back the month-end closing of ${month} because ${because}`
  } else {
    await recordReopening(
      tx,
      before,
      actor,
      `${because[0]!.toUpperCase()}${because.slice(1)} on ${today}.`
    )
    data = REOPENED
    description = `Reopened ${month} because ${because}`
    also.push({ field: 'Why it was reopened' })
  }
  await tx.monthlyReport.update({ where: { id: reportId }, data })
  return {
    id: reportId,
    period: before.period,
    was,
    entry: {
      workspaceId: engagement.workspaceId,
      resource: 'report',
      subjectId: reportId,
      action: 'review',
      description,
      changes: [...changesOf(before, data, REPORT_FIELDS), ...also],
    },
  }
}
