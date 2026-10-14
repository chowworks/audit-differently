import { Logger } from '@nestjs/common'
import type { Document, Prisma } from '@prisma/client'
import { DOCUMENT_KIND_LABELS, type DocumentKind } from '@ad/types'
import { monthName } from '../core/changes'
import type { DocumentStorage } from '../storage/document-storage.interface'

/** A document kind as the access log says it: "an invoice", "a pay stub", "the contract". */
export function kindPhrase(kind: string, article: 'a' | 'the' = 'a'): string {
  const word = DOCUMENT_KIND_LABELS[kind as DocumentKind] ?? 'document'
  if (article === 'the') return `the ${word}`
  return `${/^([aeiou]|MOU)/i.test(word) ? 'an' : 'a'} ${word}`
}

/**
 * A document as the access log names it: its kind and month, and whether it is personal. Never its file name,
 * which may carry a person's name.
 */
export function describe(
  doc: { kind: string; sensitivity: string; period: string | null },
  article: 'a' | 'the' = 'a'
): string {
  return `${kindPhrase(doc.kind, article)}${doc.period ? ` for ${monthName(doc.period)}` : ''}${doc.sensitivity === 'personal' ? ' (personal)' : ''}`
}

/**
 * An upload that passed every check (role, type, bytes, size) and is not stored yet. `commit` puts the object
 * in storage and then runs the one transaction that creates its row (with `create`) and whatever goes with it;
 * if that transaction fails, the object is deleted again, best effort, so a failure leaves nothing half done.
 */
export class StagedFile {
  private static readonly logger = new Logger('StagedFile')
  /** The row, once `create` ran. */
  row: Document | null = null

  constructor(
    private readonly storage: DocumentStorage,
    readonly data: Prisma.DocumentUncheckedCreateInput & {
      workspaceId: string
      engagementId: string | null
      kind: DocumentKind
      sensitivity: string
      period: string | null
      storageKey: string
    },
    private readonly buffer: Buffer
  ) {}

  async create(tx: Prisma.TransactionClient): Promise<Document> {
    this.row = await tx.document.create({ data: this.data })
    return this.row
  }

  async commit<T>(save: () => Promise<T>): Promise<T> {
    await this.storage.upload(this.data.storageKey, this.buffer, this.data.contentType)
    try {
      return await save()
    } catch (e) {
      this.row = null
      StagedFile.logger.error(
        `Saving the upload ${this.data.storageKey} failed, so its object is deleted: ${(e as Error).message}`
      )
      await this.storage
        .delete(this.data.storageKey)
        .catch((err: unknown) =>
          StagedFile.logger.error(
            `Could not delete the uploaded object ${this.data.storageKey} after its save failed: ${(err as Error).message}`
          )
        )
      throw e
    }
  }
}
