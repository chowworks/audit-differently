import { ForbiddenException, NotFoundException } from '@nestjs/common'
import type { DocumentKind, Role } from '@ad/types'
import { member, scoped, stranger, W } from '../core/testing/callers'
import { DocumentsService } from './documents.service'

/**
 * The gates on a document: a member of another workspace never sees it; owners and bookkeepers upload and
 * remove; a personal record opens for owners and auditors only, as a download, for sixty seconds, and logged.
 */
const row = (id: string, kind: string, sensitivity: string) => ({
  id,
  workspaceId: W,
  kind,
  sensitivity,
  fileName: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 1,
  period: null,
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
  storageKey: `${W}/workspace/general/${id}.pdf`,
  _count: { expenses: 0, participants: 0, wexPayments: 0 },
})
const invoice = row('d-inv', 'invoice', 'financial')
const birthCertificate = row('d-age', 'eligibility-record', 'personal')

function service() {
  const prisma = {
    document: {
      ...scoped(invoice, birthCertificate),
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: 'd-new',
        uploadedAt: new Date('2026-10-02T00:00:00Z'),
        ...data,
      })),
      delete: jest.fn(),
    },
    engagement: scoped(),
  }
  const log = { log: jest.fn().mockResolvedValue(undefined) }
  const storage = {
    upload: jest.fn(),
    getSignedUrl: jest.fn(
      async (key: string, seconds: number, options?: { downloadName?: string }) =>
        `signed:${key}:${seconds}:${options?.downloadName ?? 'inline'}`
    ),
    delete: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(),
  }
  return {
    service: new DocumentsService(prisma as never, log as never, storage),
    prisma,
    log,
    storage,
  }
}

const file = {
  originalname: 'card.pdf',
  mimetype: 'application/pdf',
  size: 3,
  buffer: Buffer.from('%PDF-1.4 demo'),
}
const upload = (kind: DocumentKind) => ({ workspaceId: W, kind })

describe('DocumentsService', () => {
  it('shows a member of another workspace nothing: 404, no file, no link, no log', async () => {
    const { service: s, prisma, log, storage } = service()
    const who = stranger()
    await expect(s.upload(who, file, upload('invoice'))).rejects.toThrow(NotFoundException)
    await expect(s.list(who, W)).rejects.toThrow(NotFoundException)
    await expect(s.remove(who, 'd-inv')).rejects.toThrow(NotFoundException)
    await expect(s.url(who, 'd-inv')).rejects.toThrow(NotFoundException)
    await expect(s.url(who, 'd-age')).rejects.toThrow(NotFoundException)
    expect(prisma.document.findMany).not.toHaveBeenCalled()
    expect(prisma.document.create).not.toHaveBeenCalled()
    expect(prisma.document.delete).not.toHaveBeenCalled()
    expect(storage.upload).not.toHaveBeenCalled()
    expect(storage.getSignedUrl).not.toHaveBeenCalled()
    expect(log.log).not.toHaveBeenCalled()
  })

  it('lets an auditor list and open, and neither upload nor remove', async () => {
    const { service: s, prisma, log, storage } = service()
    const who = member('auditor')
    expect(await s.list(who, W)).toHaveLength(2)
    expect(prisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ workspaceId: W }, { workspaceId: { in: [W] } }] },
      })
    )
    expect(log.log).toHaveBeenCalledWith(
      who,
      expect.objectContaining({ workspaceId: W, resource: 'document', action: 'list' })
    )
    await expect(s.upload(who, file, upload('invoice'))).rejects.toThrow(ForbiddenException)
    await expect(s.remove(who, 'd-inv')).rejects.toThrow(ForbiddenException)
    expect(storage.upload).not.toHaveBeenCalled()
    expect(prisma.document.delete).not.toHaveBeenCalled()
  })

  it('lets a bookkeeper upload a personal record, and marks it so', async () => {
    const { service: s, prisma, log } = service()
    const who = member('bookkeeper')
    const doc = await s.upload(who, file, upload('eligibility-record'))
    expect(doc.sensitivity).toBe('personal')
    expect(prisma.document.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: W,
        kind: 'eligibility-record',
        sensitivity: 'personal',
        uploadedById: who.userId,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    })
    expect(log.log).toHaveBeenCalledWith(
      who,
      expect.objectContaining({ resource: 'document', action: 'create', subjectId: 'd-new' })
    )
  })

  it('opens a financial document to a bookkeeper inline for two minutes, and logs it', async () => {
    const { service: s, log } = service()
    const who = member('bookkeeper')
    expect(await s.url(who, 'd-inv')).toEqual({
      url: `signed:${invoice.storageKey}:120:inline`,
      expiresInSeconds: 120,
    })
    expect(log.log).toHaveBeenCalledWith(
      who,
      expect.objectContaining({ resource: 'document', subjectId: 'd-inv', action: 'read' })
    )
  })

  it('does not open a personal record to the bookkeeper who may attach it', async () => {
    const { service: s, log, storage } = service()
    await expect(s.url(member('bookkeeper'), 'd-age')).rejects.toThrow(ForbiddenException)
    expect(storage.getSignedUrl).not.toHaveBeenCalled()
    expect(log.log).not.toHaveBeenCalled()
  })

  it.each(['owner', 'auditor'] as Role[])(
    'opens a personal record to an %s as a sixty-second download, and logs it as personal',
    async (role) => {
      const { service: s, log } = service()
      const who = member(role)
      expect(await s.url(who, 'd-age')).toEqual({
        url: `signed:${birthCertificate.storageKey}:60:d-age.pdf`,
        expiresInSeconds: 60,
      })
      expect(log.log).toHaveBeenCalledWith(
        who,
        expect.objectContaining({
          resource: 'document',
          subjectId: 'd-age',
          action: 'read',
          detail: expect.stringContaining('(personal)'),
        })
      )
    }
  )

  it('lets a bookkeeper remove an unattached document, and logs it', async () => {
    const { service: s, prisma, log, storage } = service()
    const who = member('bookkeeper')
    await s.remove(who, 'd-inv')
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: 'd-inv' } })
    expect(storage.delete).toHaveBeenCalledWith(invoice.storageKey)
    expect(log.log).toHaveBeenCalledWith(
      who,
      expect.objectContaining({ resource: 'document', subjectId: 'd-inv', action: 'delete' })
    )
  })
})
