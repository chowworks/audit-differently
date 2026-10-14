import { BadRequestException, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { DOCUMENT_KIND_LABELS, type DocumentKind } from '@ad/types'
import type { AccessLogService, LogEntry } from '../core/access-log.service'
import type { Caller } from '../core/caller'
import type { PrismaService } from '../prisma/prisma.service'
import { kindPhrase, type StagedFile } from './staged-file'

/**
 * Thrown inside an `AccessLogService.change` write when the request changes nothing (the same proof slot, a save
 * with nothing edited): the transaction is undone, so neither a write nor a line is left, and the caller treats
 * it as done.
 */
export class NothingChanged extends Error {}

/** Runs `change`; a NothingChanged inside it means there was nothing to do. */
export async function unlessUnchanged(change: () => Promise<unknown>): Promise<void> {
  try {
    await change()
  } catch (e) {
    if (!(e instanceof NothingChanged)) throw e
  }
}

/** A record that takes documents as proof: an expense, a work-experience payment, a participant's file. */
export interface LinkTarget {
  workspaceId: string
  engagementId: string
  resource: LogEntry['resource']
  subjectId: string
  /** The record in a sentence: "expense 1001", "a participant's file in Coding Pathway". */
  subject: string
  purpose: string
  /** A purpose in words: "evidence of payment", "proof of age (birth certificate or state ID)". */
  words: (purpose: string) => string
  /** A participant's file names the checklist item the upload fills, not the kind of document. */
  namesItem?: boolean
  find: (tx: Prisma.TransactionClient, documentId: string) => Promise<{ purpose: string } | null>
  create: (tx: Prisma.TransactionClient, documentId: string) => Promise<unknown>
  move: (tx: Prisma.TransactionClient, documentId: string) => Promise<unknown>
}

/**
 * Puts a document in a record's proof slot, in one transaction with one line: a document the workspace already
 * holds (by id), or a new upload (a StagedFile, stored first and deleted again if the transaction fails). A
 * document already in that slot changes nothing and logs nothing; one in another slot of the same record moves,
 * and the line says so. The caller has checked the record and the caller's right to change it.
 */
export async function linkDocument(
  prisma: PrismaService,
  log: AccessLogService,
  caller: Caller,
  t: LinkTarget,
  source: string | StagedFile
): Promise<void> {
  const base = { workspaceId: t.workspaceId, resource: t.resource, subjectId: t.subjectId }
  if (typeof source !== 'string') {
    if (source.data.workspaceId !== t.workspaceId || source.data.engagementId !== t.engagementId)
      throw new BadRequestException("The file must be filed under this record's engagement")
    const kind = source.data.kind
    const personal = source.data.sensitivity === 'personal' ? ' (personal)' : ''
    const as =
      t.words(t.purpose) === DOCUMENT_KIND_LABELS[kind as DocumentKind]
        ? ''
        : ` as ${t.words(t.purpose)}`
    const description = t.namesItem
      ? `Uploaded ${t.words(t.purpose)} to ${t.subject}`
      : `Uploaded ${kindPhrase(kind)}${personal} and attached it to ${t.subject}${as}`
    await source.commit(() =>
      log.change(
        caller,
        async (tx) => {
          const doc = await source.create(tx)
          await t.create(tx, doc.id)
        },
        { ...base, action: 'update', description }
      )
    )
    return
  }
  const doc = await prisma.document.findFirst({
    where: { id: source, workspaceId: t.workspaceId },
  })
  if (!doc) throw new NotFoundException('No such document in this workspace')
  await unlessUnchanged(() =>
    log.change(
      caller,
      async (tx) => {
        const link = await t.find(tx, doc.id)
        if (link?.purpose === t.purpose) throw new NothingChanged()
        if (link) await t.move(tx, doc.id)
        else await t.create(tx, doc.id)
        return link?.purpose ?? null
      },
      (from) => ({
        ...base,
        action: 'update',
        description: from
          ? `Moved ${kindPhrase(doc.kind)} on ${t.subject} from ${t.words(from)} to ${t.words(t.purpose)}`
          : `Attached ${t.words(t.purpose)} to ${t.subject}`,
      })
    )
  )
}
