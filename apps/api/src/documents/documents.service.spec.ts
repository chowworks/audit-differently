import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { DocumentKind, Role } from '@ad/types'
import type { Caller } from '../core/caller'
import { member, OTHER, scoped, stranger, W } from '../core/testing/callers'
import { expectNoneOf, fakeLog } from '../core/testing/log'
import { DocumentsService, type UploadBody } from './documents.service'
import type { StagedFile } from './staged-file'

/**
 * The gates on a document: a member of another workspace never sees it; owners and bookkeepers upload and
 * remove; a personal record opens for owners and auditors only, as a download, for sixty seconds, and logged.
 * Every upload is one call, one transaction and one line, whatever it is for.
 */
const row = (
  id: string,
  kind: string,
  sensitivity: string,
  extra: { engagementId?: string; uses?: number; storageKey?: string; period?: string } = {}
) => ({
  id,
  workspaceId: W,
  engagementId: extra.engagementId ?? null,
  kind,
  sensitivity,
  fileName: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 1,
  period: extra.period ?? null,
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
  storageKey:
    extra.storageKey ??
    `${W}/${extra.engagementId ?? 'workspace'}/${extra.period ?? 'general'}/${id}.pdf`,
  _count: { expenses: extra.uses ?? 0, participants: 0, wexPayments: 0 },
})
const invoice = row('d-inv', 'invoice', 'financial')
const birthCertificate = row('d-age', 'eligibility-record', 'personal')
const payStub = row('d-stub', 'paystub', 'personal')
const contract = row('d-contract', 'contract', 'financial', { engagementId: 'e-1' })
const attached = row('d-attached', 'contract', 'financial', { engagementId: 'e-1', uses: 1 })
// Filed under August, whose month-end closing is approved.
const augustStatement = row('d-aug', 'bank-statement', 'financial', {
  engagementId: 'e-1',
  period: '2026-08',
})
// September's signed copies: the one submitted before the month was reopened (a reopening keeps it), and the
// corrected one attached since, not submitted yet.
const keptSigned = row('d-signed-kept', 'signed-report', 'financial', {
  engagementId: 'e-1',
  period: '2026-09',
})
const correctedSigned = row('d-signed-new', 'signed-report', 'financial', {
  engagementId: 'e-1',
  period: '2026-09',
})
// October is submitted (on November 9), with the signed copy that was on file then.
const octoberSigned = row('d-signed-oct', 'signed-report', 'financial', {
  engagementId: 'e-1',
  period: '2026-10',
})
const tampered = row('d-bad', 'invoice', 'financial', {
  storageKey: `${OTHER}/workspace/general/d-bad.pdf`,
})

function service() {
  const prisma = {
    document: {
      ...scoped(
        invoice,
        birthCertificate,
        contract,
        attached,
        tampered,
        augustStatement,
        keptSigned,
        correctedSigned,
        octoberSigned
      ),
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: 'd-new',
        uploadedAt: new Date('2026-10-02T00:00:00Z'),
        ...data,
      })),
      delete: jest.fn(),
    },
    engagement: {
      ...scoped({
        id: 'e-1',
        workspaceId: W,
        waivers: { 'award-letter': 'Jordan Sample said the funder sent none' },
      }),
      update: jest.fn(),
    },
    expense: scoped({ id: 'x-1', workspaceId: W, itemNumber: '1001' }),
    // August's month-end closing is approved; September is a draft (reopened); October is submitted.
    monthlyReport: {
      findFirst: jest.fn(async ({ where }: { where: { engagementId: string; period: string } }) =>
        where.engagementId !== 'e-1'
          ? null
          : where.period === '2026-08'
            ? { period: where.period, status: 'closed', submittedAt: null }
            : where.period === '2026-09'
              ? { period: where.period, status: 'draft', submittedAt: null }
              : where.period === '2026-10'
                ? {
                    period: where.period,
                    status: 'submitted',
                    submittedAt: new Date('2026-11-09T00:00:00Z'),
                  }
                : null
      ),
    },
    // September's reopening kept the signed copy submitted on October 8.
    reportReopening: {
      findFirst: jest.fn(async ({ where }: { where: { signedDocumentId: string } }) =>
        where.signedDocumentId === 'd-signed-kept'
          ? { submittedAt: new Date('2026-10-08T00:00:00Z') }
          : null
      ),
    },
    wexPayment: scoped({ id: 'wx-1', workspaceId: W, monthlyReport: { period: '2026-09' } }),
  }
  const log = fakeLog(prisma)
  const storage = {
    upload: jest.fn(),
    getSignedUrl: jest.fn(
      async (
        key: string,
        seconds: number,
        options?: { downloadName?: string; inlineName?: string }
      ) =>
        `signed:${key}:${seconds}:${options?.downloadName ?? (options?.inlineName ? `inline:${options.inlineName}` : 'inline')}`
    ),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteByPrefix: jest.fn(),
    putFile: jest.fn(),
    read: jest.fn(),
  }
  // The records' own services: they check the record, then save the staged file in one logged transaction.
  const save =
    (resource: 'expense' | 'participant', description: string, answer?: unknown) =>
    async (caller: Caller, id: string, _purpose: string, staged: StagedFile) => {
      await staged.commit(() =>
        log.change(caller, (tx) => staged.create(tx as never), {
          workspaceId: W,
          resource,
          subjectId: id,
          action: 'update',
          description,
        })
      )
      return answer
    }
  const reports = {
    attachToExpense: jest.fn(
      save('expense', 'Uploaded an invoice and attached it to expense 1001', { id: 'r-1' })
    ),
    attachToWex: jest.fn(),
  }
  const participants = {
    attach: jest.fn(
      save('participant', "Uploaded proof of age to a participant's file in Coding Pathway", 'e-1')
    ),
  }
  // The unlogged load of the engagement's page: what an upload into a participant's file answers with.
  const engagements = {
    detail: jest.fn(async (_caller: Caller, id: string) => ({ id, participantsComplete: 1 })),
  }
  const failures = { record: jest.fn().mockResolvedValue(undefined) }
  return {
    service: new DocumentsService(
      prisma as never,
      log as never,
      storage,
      reports as never,
      participants as never,
      engagements as never,
      failures as never
    ),
    prisma,
    log,
    failures,
    storage,
    reports,
    participants,
    engagements,
  }
}

const file = {
  originalname: 'Jordan Sample card.pdf',
  mimetype: 'application/pdf',
  size: 3,
  buffer: Buffer.from('%PDF-1.4 demo'),
}
const upload = (kind: DocumentKind, extra: Partial<UploadBody> = {}): UploadBody => ({
  workspaceId: W,
  kind,
  ...extra,
})

describe('DocumentsService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined))
  afterEach(() => jest.restoreAllMocks())

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
    expect(log.entries).toEqual([])
  })

  it('lets an auditor list and open, and neither upload nor remove', async () => {
    const { service: s, prisma, log, storage } = service()
    const who = member('auditor')
    expect(await s.list(who, W)).toHaveLength(9)
    expect(prisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ workspaceId: W }, { workspaceId: { in: [W] } }] },
      })
    )
    await expect(s.upload(who, file, upload('invoice'))).rejects.toThrow(ForbiddenException)
    await expect(
      s.upload(
        who,
        file,
        upload('invoice', { attachTo: 'expense', attachId: 'x-1', purpose: 'invoice' })
      )
    ).rejects.toThrow(ForbiddenException)
    await expect(s.remove(who, 'd-inv')).rejects.toThrow(ForbiddenException)
    expect(storage.upload).not.toHaveBeenCalled()
    expect(prisma.document.delete).not.toHaveBeenCalled()
    expect(log.entries.map((e) => e.description)).toEqual(['Listed 9 documents of the workspace'])
  })

  it('words the attach list for the record it is for, and logs it whatever the context says', async () => {
    const { service: s, log } = service()
    const who = member('bookkeeper')
    await s.list(who, W, { for: 'expense', id: 'x-1' })
    await s.list(who, W, { for: 'wex', id: 'wx-1' })
    // No context, a made-up one, or a record this workspace does not hold: still one line each.
    await s.list(who, W)
    await s.list(who, W, { for: 'nothing', id: 'x-1' })
    await s.list(who, W, { for: 'expense', id: 'x-elsewhere' })
    await s.list(who, W, { for: 'expense', id: { off: true } as never })
    await s.list(who, W, { for: 'silent' } as never)
    expect(log.entries.map((e) => [e.resource, e.action, e.description])).toEqual([
      ['document', 'list', 'Listed 9 documents to choose proof for expense 1001'],
      [
        'document',
        'list',
        'Listed 9 documents to choose proof for a work-experience payment in September 2026',
      ],
      ['document', 'list', 'Listed 9 documents of the workspace'],
      ['document', 'list', 'Listed 9 documents of the workspace'],
      ['document', 'list', 'Listed 9 documents of the workspace'],
      ['document', 'list', 'Listed 9 documents of the workspace'],
      ['document', 'list', 'Listed 9 documents of the workspace'],
    ])
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
        size: 3,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    })
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'document',
        subjectId: 'd-new',
        action: 'create',
        description: 'Uploaded an eligibility record (personal)',
      },
    ])
  })

  it('refuses bytes that are not what the browser claims before storing anything', async () => {
    const { service: s, storage, log } = service()
    await expect(
      s.upload(member('owner'), { ...file, buffer: Buffer.from('MZ not a pdf') }, upload('invoice'))
    ).rejects.toThrow('The file does not look like a pdf')
    expect(storage.upload).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('deletes the stored object again when the save fails, and logs nothing', async () => {
    const { service: s, prisma, storage, log, failures } = service()
    prisma.document.create.mockRejectedValueOnce(new Error('database down'))
    await expect(s.upload(member('owner'), file, upload('invoice'))).rejects.toThrow(
      'database down'
    )
    expect(storage.upload).toHaveBeenCalledTimes(1)
    expect(storage.delete).toHaveBeenCalledWith(storage.upload.mock.calls[0][0])
    expect(log.entries).toEqual([])
    expect(Logger.prototype.error).toHaveBeenCalled()
    // not the person's fault, so the upload-failures health check counts it
    expect(failures.record).toHaveBeenCalledWith('upload', 'POST /api/documents')
  })

  it('counts an upload storage refused for the health check, and saves nothing', async () => {
    const { service: s, prisma, storage, failures } = service()
    storage.upload.mockRejectedValueOnce(new Error('InternalError'))
    await expect(s.upload(member('owner'), file, upload('invoice'))).rejects.toThrow(
      'InternalError'
    )
    expect(prisma.document.create).not.toHaveBeenCalled()
    expect(failures.record).toHaveBeenCalledWith('upload', 'POST /api/documents')
  })

  it("does not count a refusal that is the request's fault", async () => {
    const { service: s, reports, storage, failures } = service()
    // the record is checked inside the save, after the object is stored
    reports.attachToExpense.mockImplementationOnce(
      async (_c: Caller, _id: string, _p: string, staged: StagedFile) =>
        staged.commit(() => Promise.reject(new NotFoundException()))
    )
    await expect(
      s.upload(
        member('bookkeeper'),
        file,
        upload('invoice', {
          engagementId: 'e-1',
          period: '2026-09',
          attachTo: 'expense',
          attachId: 'x-1',
          purpose: 'invoice',
        })
      )
    ).rejects.toThrow(NotFoundException)
    expect(storage.delete).toHaveBeenCalled()
    expect(failures.record).not.toHaveBeenCalled()
  })

  it('uploads and attaches in one call: the record decides, and the answer carries the month', async () => {
    const { service: s, log, reports, participants, storage } = service()
    const who = member('bookkeeper')
    const answer = await s.upload(
      who,
      file,
      upload('invoice', {
        engagementId: 'e-1',
        period: '2026-09',
        attachTo: 'expense',
        attachId: 'x-1',
        purpose: 'invoice',
      })
    )
    expect(reports.attachToExpense).toHaveBeenCalledWith(who, 'x-1', 'invoice', expect.anything())
    expect(answer).toMatchObject({ id: 'd-new', kind: 'invoice', report: { id: 'r-1' } })
    // A bookkeeper files a participant's record without reading it back.
    const filed = await s.upload(
      who,
      file,
      upload('eligibility-record', {
        engagementId: 'e-1',
        attachTo: 'participant',
        attachId: 'p-1',
        purpose: 'proof-of-age',
      })
    )
    expect(participants.attach).toHaveBeenCalledWith(who, 'p-1', 'proof-of-age', expect.anything())
    expect(filed).toMatchObject({ id: 'd-new', sensitivity: 'personal' })
    expect(storage.upload).toHaveBeenCalledTimes(2)
    expect(log.entries.map((e) => e.description)).toEqual([
      'Uploaded an invoice and attached it to expense 1001',
      "Uploaded proof of age to a participant's file in Coding Pathway",
    ])
    expectNoneOf(log.entries, ['Jordan', 'card.pdf'])
  })

  it("answers an upload into a participant's file with the engagement's page, and writes its one line only", async () => {
    const { service: s, log, engagements } = service()
    const who = member('bookkeeper')
    const filed = await s.upload(
      who,
      file,
      upload('eligibility-record', {
        engagementId: 'e-1',
        attachTo: 'participant',
        attachId: 'p-1',
        purpose: 'proof-of-age',
      })
    )
    expect(engagements.detail).toHaveBeenCalledWith(who, 'e-1')
    expect(filed).toMatchObject({ id: 'd-new', engagement: { id: 'e-1', participantsComplete: 1 } })
    // The change line alone: handing the page back is not the page being opened.
    expect(log.log).not.toHaveBeenCalled()
    expect(log.entries.map((e) => [e.resource, e.action])).toEqual([['participant', 'update']])
  })

  it('refuses an upload that asks for two things, or attaches to nothing it knows, before storing', async () => {
    const { service: s, storage, log, reports } = service()
    const who = member('bookkeeper')
    await expect(
      s.upload(
        who,
        file,
        upload('contract', { engagementId: 'e-1', replaces: 'd-contract', clearsWaiver: 'true' })
      )
    ).rejects.toThrow(BadRequestException)
    await expect(
      s.upload(
        who,
        file,
        upload('invoice', { attachTo: 'budget', attachId: 'x-1', purpose: 'invoice' })
      )
    ).rejects.toThrow(BadRequestException)
    await expect(s.upload(who, file, upload('invoice', { attachTo: 'expense' }))).rejects.toThrow(
      BadRequestException
    )
    expect(reports.attachToExpense).not.toHaveBeenCalled()
    expect(storage.upload).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('replaces an unattached document in one transaction with one line', async () => {
    const { service: s, prisma, storage, log } = service()
    const who = member('bookkeeper')
    const doc = await s.upload(
      who,
      file,
      upload('contract', { engagementId: 'e-1', replaces: 'd-contract' })
    )
    expect(doc.id).toBe('d-new')
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: 'd-contract' } })
    expect(storage.upload).toHaveBeenCalledTimes(1)
    expect(storage.delete).toHaveBeenCalledWith(contract.storageKey)
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'document',
        subjectId: 'd-new',
        action: 'update',
        description: 'Replaced the contract',
      },
    ])
  })

  it('refuses to replace an attached document with 409, before uploading anything', async () => {
    const { service: s, prisma, storage, log } = service()
    await expect(
      s.upload(
        member('bookkeeper'),
        file,
        upload('contract', { engagementId: 'e-1', replaces: 'd-attached' })
      )
    ).rejects.toThrow(ConflictException)
    await expect(
      s.upload(
        member('owner'),
        file,
        upload('contract', { engagementId: 'e-1', replaces: 'd-gone' })
      )
    ).rejects.toThrow(NotFoundException)
    expect(storage.upload).not.toHaveBeenCalled()
    expect(prisma.document.delete).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it("uploads a missing record and removes the engagement's reason for it in one line", async () => {
    const { service: s, prisma, log } = service()
    const doc = await s.upload(
      member('owner'),
      file,
      upload('award-letter', { engagementId: 'e-1', clearsWaiver: 'true' })
    )
    // The answer is the new document; the page drops the reason itself, as the server did.
    expect(doc).toMatchObject({ id: 'd-new', kind: 'award-letter' })
    expect(prisma.engagement.update).toHaveBeenCalledWith({
      where: { id: 'e-1' },
      data: { waivers: {} },
    })
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'document',
        subjectId: 'd-new',
        action: 'create',
        description: 'Uploaded the award letter and removed the reason it was missing',
        changes: [{ field: 'No award letter (reason)' }],
      },
    ])
    expectNoneOf(log.entries, ['Jordan', 'funder sent none'])
  })

  it('opens a financial document to a bookkeeper inline for two minutes under its original name, and logs it', async () => {
    const { service: s, log } = service()
    const who = member('bookkeeper')
    expect(await s.url(who, 'd-inv')).toEqual({
      url: `signed:${invoice.storageKey}:120:inline:${invoice.fileName}`,
      expiresInSeconds: 120,
    })
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'document',
        subjectId: 'd-inv',
        action: 'read',
        description: 'Opened an invoice',
      },
    ])
  })

  it('hands over no list when the access log cannot be written, and keeps file names out of the log', async () => {
    const { service: s, log } = service()
    log.log.mockRejectedValueOnce(new Error('log down'))
    await expect(s.list(member('bookkeeper'), W)).rejects.toThrow('log down')
    await s.url(member('owner'), 'd-age')
    await s.upload(member('owner'), file, upload('eligibility-record'))
    expect(log.entries.map((e) => e.description)).toEqual([
      'Downloaded an eligibility record (personal)',
      'Uploaded an eligibility record (personal)',
    ])
    expect(JSON.stringify(log.entries)).not.toMatch(/d-age\.pdf|card\.pdf/)
  })

  it('does not open a personal record to the bookkeeper who may attach it', async () => {
    const { service: s, log, storage } = service()
    await expect(s.url(member('bookkeeper'), 'd-age')).rejects.toThrow(ForbiddenException)
    expect(storage.getSignedUrl).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('opens a pay stub, and no other personal record, to a bookkeeper: in the browser for sixty seconds, logged', async () => {
    const { service: s, prisma, log } = service()
    prisma.document.findFirst.mockResolvedValueOnce(payStub)
    expect(await s.url(member('bookkeeper'), 'd-stub')).toEqual({
      url: `signed:${payStub.storageKey}:60:inline:d-stub.pdf`,
      expiresInSeconds: 60,
    })
    expect(log.entries.map((e) => e.description)).toEqual(['Opened a pay stub (personal)'])
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
      expect(log.entries.map((e) => e.description)).toEqual([
        'Downloaded an eligibility record (personal)',
      ])
    }
  )

  it("holds a closed month's proof: no upload, replacement or removal; the signed report and a draft month stay open", async () => {
    const { service: s, prisma, storage, log } = service()
    const who = member('bookkeeper')
    const august = { engagementId: 'e-1', period: '2026-08' }
    await expect(s.upload(who, file, upload('invoice', august))).rejects.toThrow(
      /month-end closing of August 2026 is approved/
    )
    await expect(
      s.upload(who, file, upload('contract', { engagementId: 'e-1', replaces: 'd-aug' }))
    ).rejects.toThrow(ConflictException)
    await expect(s.remove(who, 'd-aug')).rejects.toThrow(ConflictException)
    expect(storage.upload).not.toHaveBeenCalled()
    expect(prisma.document.delete).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
    await s.upload(who, file, upload('signed-report', august))
    await s.upload(who, file, upload('invoice', { engagementId: 'e-1', period: '2026-09' }))
    expect(storage.upload).toHaveBeenCalledTimes(2)
  })

  it('never replaces or removes the signed copy that was submitted; the corrected one goes beside it', async () => {
    const { service: s, prisma, storage, log } = service()
    const who = member('owner')
    const september = { engagementId: 'e-1', period: '2026-09' }
    for (const id of ['d-signed-kept', 'd-signed-oct']) {
      await expect(s.remove(who, id)).rejects.toThrow(ConflictException)
      await expect(
        s.upload(who, file, upload('signed-report', { ...september, replaces: id }))
      ).rejects.toThrow(ConflictException)
    }
    await expect(s.remove(who, 'd-signed-kept')).rejects.toThrow(
      'This is the signed copy that was submitted on October 8, 2026; attach the corrected one alongside it'
    )
    await expect(s.remove(who, 'd-signed-oct')).rejects.toThrow(
      'This is the signed copy that was submitted on November 9, 2026; attach the corrected one alongside it'
    )
    expect(storage.upload).not.toHaveBeenCalled()
    expect(prisma.document.delete).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
    // A corrected copy not submitted yet may still be replaced or removed; attaching one beside it is an upload.
    await s.upload(who, file, upload('signed-report', september))
    await s.remove(who, 'd-signed-new')
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: 'd-signed-new' } })
  })

  it('lets a bookkeeper remove an unattached document, and logs it', async () => {
    const { service: s, prisma, log, storage } = service()
    await s.remove(member('bookkeeper'), 'd-inv')
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: 'd-inv' } })
    expect(storage.delete).toHaveBeenCalledWith(invoice.storageKey)
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'document',
        subjectId: 'd-inv',
        action: 'delete',
        description: 'Removed an invoice',
      },
    ])
  })

  it('refuses a removal whose key names another workspace: nothing deleted, nothing logged', async () => {
    const { service: s, prisma, log, storage } = service()
    await expect(s.remove(member('owner'), 'd-bad')).rejects.toThrow(NotFoundException)
    await expect(s.remove(member('owner'), 'd-attached')).rejects.toThrow(ConflictException)
    expect(prisma.document.delete).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('keeps a removal when storage refuses the file, and records the leftover by id and key', async () => {
    const { service: s, log, storage } = service()
    storage.delete.mockRejectedValueOnce(new Error('R2 unavailable'))
    await s.remove(member('owner'), 'd-inv')
    expect(log.entries.map((e) => [e.action, e.subjectId, e.description])).toEqual([
      ['delete', 'd-inv', 'Removed an invoice'],
      ['delete', 'd-inv', 'The file of a removed invoice could not be deleted from storage'],
    ])
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining(`Document d-inv: its file ${invoice.storageKey}`)
    )
  })
})
