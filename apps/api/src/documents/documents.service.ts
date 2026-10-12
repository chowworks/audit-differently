import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'

/** Where an object is filed: by workspace, then by engagement (or 'workspace' for none), then by month or 'general'. */
export function objectFolder(doc: {
  workspaceId: string
  engagementId?: string | null
  period?: string | null
}): string {
  return `${doc.workspaceId}/${doc.engagementId ?? 'workspace'}/${doc.period ?? 'general'}/`
}

/**
 * Every object lives under its workspace and engagement (the database enforces the key on write, migrations
 * 20261011000600 and ..0700); a row that says otherwise is tampered or broken, and nothing is served from it.
 */
export function keyInWorkspace(doc: {
  storageKey: string
  workspaceId: string
  engagementId?: string | null
}): boolean {
  return doc.storageKey.startsWith(`${doc.workspaceId}/${doc.engagementId ?? 'workspace'}/`)
}
import {
  ALLOWED_UPLOAD_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_SENSITIVITY,
  PERSONAL_DOCUMENT_ROLES,
  WRITE_ROLES,
  type DocumentDto,
  type DocumentKind,
  type Role,
} from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'
import { documentDto } from './document.dto'

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** The first bytes each allowed type starts with; Office files are zip archives. */
const SIGNATURES: Record<string, Buffer[]> = {
  'application/pdf': [Buffer.from('%PDF-')],
  'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [Buffer.from('PK\x03\x04')],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    Buffer.from('PK\x03\x04'),
  ],
}

/** Whether the bytes begin the way files of `mimetype` do; the browser's claim alone is never trusted. */
export function looksLike(buffer: Buffer, mimetype: string): boolean {
  const starts = SIGNATURES[mimetype]
  if (!starts) return false
  return starts.some(
    (sig) => buffer.length >= sig.length && buffer.subarray(0, sig.length).equals(sig)
  )
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage
  ) {}

  async upload(
    caller: Caller,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    body: { workspaceId: string; kind: DocumentKind; period?: string; engagementId?: string }
  ): Promise<DocumentDto> {
    if (!caller.workspaceIds.includes(body.workspaceId))
      throw new NotFoundException('No such workspace')
    allow(
      workspaceRole(caller, body.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper uploads'
    )
    if (!DOCUMENT_KINDS.includes(body.kind))
      throw new BadRequestException('kind is not one of the allowed values')
    const ext = ALLOWED_UPLOAD_TYPES[file.mimetype]
    if (ext && !looksLike(file.buffer, file.mimetype))
      throw new BadRequestException(`The file does not look like a ${ext}`)
    if (!ext)
      throw new BadRequestException(
        `Uploads must be one of: ${Object.values(ALLOWED_UPLOAD_TYPES).join(', ')}`
      )
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('Uploads are limited to 25 MB')
    if (body.period && !/^\d{4}-\d{2}$/.test(body.period))
      throw new BadRequestException('period must be YYYY-MM')
    if (body.engagementId) {
      const c = await this.prisma.engagement.findFirst({
        where: { id: body.engagementId, workspaceId: body.workspaceId },
      })
      if (!c) throw new BadRequestException('engagementId is not an engagement of this workspace')
    }
    const storageKey = `${objectFolder(body)}${randomUUID()}.${ext}`
    await this.storage.upload(storageKey, file.buffer, file.mimetype)
    const doc = await this.prisma.document.create({
      data: {
        workspaceId: body.workspaceId,
        engagementId: body.engagementId || null,
        kind: body.kind,
        sensitivity: DOCUMENT_SENSITIVITY[body.kind],
        fileName: file.originalname.replace(/[^\w.() -]+/g, '_').slice(0, 200),
        contentType: file.mimetype,
        size: file.size,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
        storageKey,
        period: body.period || null,
        uploadedById: caller.userId,
      },
    })
    await this.log.log(caller, {
      workspaceId: body.workspaceId,
      resource: 'document',
      subjectId: doc.id,
      action: 'create',
      detail: doc.kind,
    })
    return documentDto(doc)
  }

  async list(caller: Caller, workspaceId: string): Promise<DocumentDto[]> {
    if (!caller.workspaceIds.includes(workspaceId)) throw new NotFoundException('No such workspace')
    const docs = await this.prisma.document.findMany({
      where: { AND: [{ workspaceId }, tenantWhere(caller)] },
      orderBy: { uploadedAt: 'desc' },
      take: 300,
    })
    await this.log.log(caller, {
      workspaceId,
      resource: 'document',
      action: 'list',
      detail: `${docs.length} documents`,
    })
    return docs.map(documentDto)
  }

  /** Removes a document that is attached to nothing: the row and the file. */
  async remove(caller: Caller, id: string): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: { _count: { select: { expenses: true, participants: true, wexPayments: true } } },
    })
    if (!doc) throw new NotFoundException()
    allow(
      workspaceRole(caller, doc.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper removes'
    )
    const uses = doc._count.expenses + doc._count.participants + doc._count.wexPayments
    if (uses > 0)
      throw new ConflictException(
        `This document is attached to ${uses} record${uses === 1 ? '' : 's'}; detach it there first`
      )
    await this.prisma.document.delete({ where: { id } })
    if (!keyInWorkspace(doc)) throw new NotFoundException()
    await this.storage.delete(doc.storageKey).catch(() => undefined)
    await this.log.log(caller, {
      workspaceId: doc.workspaceId,
      resource: 'document',
      subjectId: doc.id,
      action: 'delete',
      detail: doc.kind,
    })
  }

  /** A short-lived link to the file. Personal documents: shorter, download only, fewer roles, and logged as such. */
  async url(caller: Caller, id: string): Promise<{ url: string; expiresInSeconds: number }> {
    const doc = await this.prisma.document.findFirst({ where: { id, ...tenantWhere(caller) } })
    if (!doc) throw new NotFoundException()
    const personal = doc.sensitivity === 'personal'
    if (personal) {
      const roles = [...PERSONAL_DOCUMENT_ROLES] as Role[]
      if (!workspaceRole(caller, doc.workspaceId, roles))
        throw new ForbiddenException('Personal documents are open to owners and auditors only')
    }
    const expiresInSeconds = personal ? 60 : 120
    if (!keyInWorkspace(doc)) throw new NotFoundException()
    const url = await this.storage.getSignedUrl(
      doc.storageKey,
      expiresInSeconds,
      personal ? { downloadName: doc.fileName } : { inlineName: doc.fileName }
    )
    await this.log.log(caller, {
      workspaceId: doc.workspaceId,
      resource: 'document',
      subjectId: doc.id,
      action: 'read',
      detail: `${doc.kind}${personal ? ' (personal)' : ''}`,
    })
    return { url, expiresInSeconds }
  }
}
