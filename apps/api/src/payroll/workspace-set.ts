import type { Document, PrismaClient } from '@prisma/client'
import {
  PAYROLL_DOCUMENT_KINDS,
  type PayrollDocumentKind,
  type WorkspacePayrollFileDto,
} from '@ad/types'
import { monthName } from '../core/changes'
import { keyInWorkspace } from '../documents/documents.service'

type Db = Pick<PrismaClient, 'document' | 'payrollMatchFile'>

/** Why a file of File Management cannot move to another folder (issue #82); null: it can. */
export const CANNOT_MOVE = {
  proves:
    'It already proves pay or a bill: remove it and match the month again, then add it to the right folder',
  record: "It is also a participant's record or payroll proof, so it stays where it is",
  held: "An upload that isn't saved yet holds it: it can move once that upload is saved or discarded",
} as const

/** Why a file cannot be renamed while an unsaved upload holds it. */
export const CANNOT_RENAME_HELD =
  "An upload that isn't saved yet holds it: it can be renamed once that upload is saved or discarded"

/** A month a file is filed on or proves, as the refusals name it. */
export interface LockedMonth {
  status: string
  period: string
  engagement: { name: string }
}

/** The file is filed on an engagement's month that is not a draft. */
export const filedOnLocked = (m: LockedMonth) =>
  `It is filed on ${m.engagement.name}'s ${monthName(m.period)}, which is ${m.status}: reopen that month first`

/** The file is proof in an engagement's month that is not a draft. */
export const proofInLocked = (m: LockedMonth) =>
  `It is proof in ${m.engagement.name}'s ${monthName(m.period)}, which is ${m.status}: reopen that month first`

/** A linked month as the refusals read it. */
export const LINKED_MONTH = {
  select: { status: true, period: true, engagement: { select: { name: true } } },
} as const

/** The month's set: its workspace payroll documents, each under its workspace's own folder. */
export async function workspaceSetOf(
  db: Db,
  workspaceId: string,
  period: string
): Promise<Document[]> {
  const docs = await db.document.findMany({
    where: {
      workspaceId,
      engagementId: null,
      period,
      kind: { in: [...PAYROLL_DOCUMENT_KINDS] },
    },
    orderBy: [{ kind: 'asc' }, { fileName: 'asc' }],
  })
  return docs.filter((d) => keyInWorkspace(d))
}

/**
 * The month's set as File Management lists it: each file, whether it was added since the month was last matched, and
 * why it cannot be moved or renamed. A file that proves anything (a pay, a staff member's pay, a line, a payment, a
 * bill's payment, a participant) moves only by being removed and matched again, so a saved match never points at a
 * file of another kind. A file an unsaved upload holds, or that is proof in a month that is not a draft, keeps its name.
 */
export async function setFileDtos(
  db: Db,
  workspaceId: string,
  period: string
): Promise<WorkspacePayrollFileDto[]> {
  const docs = await workspaceSetOf(db, workspaceId, period)
  if (!docs.length) return []
  const ids = docs.map((d) => d.id)
  const [used, held] = await Promise.all([
    db.document.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        _count: {
          select: {
            payLines: true,
            staffPayProofs: true,
            expenses: true,
            wexPayments: true,
            participants: true,
            booksPayments: true,
          },
        },
        expenses: { select: { expense: { select: { monthlyReport: LINKED_MONTH } } } },
        wexPayments: { select: { wexPayment: { select: { monthlyReport: LINKED_MONTH } } } },
      },
    }),
    db.payrollMatchFile.findMany({
      where: { documentId: { in: ids } },
      select: { documentId: true },
    }),
  ])
  const proves = new Set(
    used.filter((u) => Object.values(u._count).some((n) => n > 0)).map((u) => u.id)
  )
  const holding = new Set(held.map((h) => h.documentId))
  const locked = new Map(
    used.flatMap((u) => {
      const m = [
        ...u.expenses.map((x) => x.expense.monthlyReport),
        ...u.wexPayments.map((x) => x.wexPayment.monthlyReport),
      ].find((r) => r.status !== 'draft')
      return m ? [[u.id, m] as const] : []
    })
  )
  return docs.map((d) => ({
    id: d.id,
    kind: d.kind as PayrollDocumentKind,
    fileName: d.fileName,
    size: d.size,
    sha256: d.sha256,
    uploadedAt: d.uploadedAt.toISOString(),
    personal: d.sensitivity === 'personal',
    contentType: d.contentType,
    notMatchedYet: d.addedSinceMatch,
    cannotMove: holding.has(d.id) ? CANNOT_MOVE.held : proves.has(d.id) ? CANNOT_MOVE.proves : null,
    cannotRename: holding.has(d.id)
      ? CANNOT_RENAME_HELD
      : locked.has(d.id)
        ? proofInLocked(locked.get(d.id)!)
        : null,
  }))
}
