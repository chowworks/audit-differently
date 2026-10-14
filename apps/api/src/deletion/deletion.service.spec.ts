import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { DELETE_PHRASE, RETAINED_COPY_DAYS, type Role } from '@ad/types'
import { member, scoped, stranger, W } from '../core/testing/callers'
import { DeletionService } from './deletion.service'

/**
 * Deleting is owner-only and permanent, so each refusal is pinned: who may not, which words must match, and which
 * export counts. What it takes away and in what order is pinned in the database spec (tenant-rls.spec.ts).
 */
const E = 'e-1'
const engagement = { id: E, workspaceId: W, name: 'Coding Pathway' }
const workspace = { id: W, name: 'Riverbend Youth Services' }
const good = { confirmName: 'Coding Pathway', confirmPhrase: DELETE_PHRASE }

const record = (extra: Record<string, unknown> = {}) => ({
  id: 'del-1',
  workspaceId: W,
  engagementId: E,
  subjectName: 'Coding Pathway',
  status: 'downloaded',
  createdAt: new Date(),
  ...extra,
})

function setup(opts: { records?: unknown[]; engagements?: number; documents?: number } = {}) {
  const calls: string[] = []
  const tx = {
    document: { deleteMany: jest.fn(async () => void calls.push('tx documents')) },
    monthlyReport: { deleteMany: jest.fn(async () => void calls.push('tx months')) },
    engagement: { delete: jest.fn(async () => void calls.push('tx engagement')) },
    deletionRecord: { update: jest.fn(async () => void calls.push('tx record')) },
  }
  const records = scoped(...((opts.records ?? [record()]) as { id?: string }[]))
  const prisma = {
    engagement: {
      ...scoped(engagement),
      count: jest.fn().mockResolvedValue(opts.engagements ?? 0),
    },
    workspace: { ...scoped(workspace), delete: jest.fn(async () => void calls.push('workspace')) },
    monthlyReport: { count: jest.fn().mockResolvedValue(12) },
    participant: { count: jest.fn().mockResolvedValue(30) },
    document: { count: jest.fn().mockResolvedValue(opts.documents ?? 0), findMany: jest.fn() },
    deletionRecord: {
      findFirst: records.findFirst,
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'del-new',
        ...data,
      })),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  }
  const log = { log: jest.fn(async () => void calls.push('log')) }
  const audit = { plan: jest.fn(), stream: jest.fn() }
  const storage = {
    deleteByPrefix: jest.fn(async (p: string) => void calls.push(`files ${p}`)),
    putFile: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(),
  }
  const service = new DeletionService(
    prisma as never,
    log as never,
    audit as never,
    storage as never
  )
  return { service, prisma, tx, log, audit, storage, calls }
}

const noWrites = (s: ReturnType<typeof setup>) => {
  expect(s.log.log).not.toHaveBeenCalled()
  expect(s.storage.deleteByPrefix).not.toHaveBeenCalled()
  expect(s.prisma.$transaction).not.toHaveBeenCalled()
  expect(s.prisma.deletionRecord.create).not.toHaveBeenCalled()
  expect(s.prisma.workspace.delete).not.toHaveBeenCalled()
}

describe('DeletionService: who may', () => {
  it.each(['bookkeeper', 'auditor'] as Role[])('refuses a %s every route', async (role) => {
    const s = setup({ documents: 1 })
    const who = member(role)
    await expect(s.service.engagementSummary(who, E)).rejects.toThrow(ForbiddenException)
    await expect(s.service.exportEngagement(who, E)).rejects.toThrow(ForbiddenException)
    await expect(s.service.downloadEngagementPart(who, E, 'del-1', 1)).rejects.toThrow(
      ForbiddenException
    )
    await expect(s.service.deleteEngagement(who, E, good)).rejects.toThrow(ForbiddenException)
    await expect(s.service.workspaceSummary(who, W)).rejects.toThrow(ForbiddenException)
    await expect(s.service.exportWorkspace(who, W)).rejects.toThrow(ForbiddenException)
    await expect(s.service.downloadWorkspacePart(who, W, 'del-1', 1)).rejects.toThrow(
      ForbiddenException
    )
    await expect(
      s.service.deleteWorkspace(who, W, { ...good, confirmName: workspace.name })
    ).rejects.toThrow(ForbiddenException)
    expect(s.audit.plan).not.toHaveBeenCalled()
    noWrites(s)
  })

  it('shows a member of another workspace nothing: 404 from every route', async () => {
    const s = setup()
    const who = stranger()
    await expect(s.service.engagementSummary(who, E)).rejects.toThrow(NotFoundException)
    await expect(s.service.exportEngagement(who, E)).rejects.toThrow(NotFoundException)
    await expect(s.service.downloadEngagementPart(who, E, 'del-1', 1)).rejects.toThrow(
      NotFoundException
    )
    await expect(s.service.deleteEngagement(who, E, good)).rejects.toThrow(NotFoundException)
    await expect(s.service.workspaceSummary(who, W)).rejects.toThrow(NotFoundException)
    await expect(s.service.exportWorkspace(who, W)).rejects.toThrow(NotFoundException)
    await expect(s.service.downloadWorkspacePart(who, W, 'del-1', 1)).rejects.toThrow(
      NotFoundException
    )
    await expect(s.service.deleteWorkspace(who, W, good)).rejects.toThrow(NotFoundException)
    expect(s.audit.plan).not.toHaveBeenCalled()
    noWrites(s)
  })

  it('counts what an owner is about to lose', async () => {
    const s = setup({ documents: 7 })
    expect(await s.service.engagementSummary(member('owner'), E)).toEqual({
      months: 12,
      participants: 30,
      documents: 7,
    })
    expect(await s.service.workspaceSummary(member('owner'), W)).toEqual({
      months: 0,
      participants: 0,
      documents: 7,
      hasWorkspaceDocuments: true,
    })
  })
})

describe('DeletionService: deleting an engagement', () => {
  const owner = member('owner')

  it.each([
    ['a wrong name', { ...good, confirmName: 'coding pathway' }],
    ['no name', { confirmPhrase: DELETE_PHRASE }],
    ['a wrong phrase', { ...good, confirmPhrase: 'delete' }],
    ['no phrase', { confirmName: good.confirmName }],
  ])('refuses %s', async (_, body) => {
    const s = setup()
    await expect(
      s.service.deleteEngagement(owner, E, { deletionId: 'del-1', ...body })
    ).rejects.toThrow(BadRequestException)
    noWrites(s)
  })

  it('refuses without a deletion id, with an unknown one, and with another engagement’s', async () => {
    for (const [deletionId, records] of [
      [undefined, [record()]],
      ['nope', [record()]],
      ['del-1', [record({ engagementId: 'e-other' })]],
      ['del-1', [record({ engagementId: null })]],
      ['del-1', [record({ workspaceId: 'ws-2' })]],
    ] as [string | undefined, unknown[]][]) {
      const s = setup({ records })
      await expect(s.service.deleteEngagement(owner, E, { ...good, deletionId })).rejects.toThrow(
        /Download the full export/
      )
      noWrites(s)
    }
  })

  it.each([['exported'], ['deleted']])('refuses an export whose status is %s', async (status) => {
    const s = setup({ records: [record({ status })] })
    await expect(
      s.service.deleteEngagement(owner, E, { ...good, deletionId: 'del-1' })
    ).rejects.toThrow(BadRequestException)
    noWrites(s)
  })

  it('refuses while any part of the export has not finished downloading', async () => {
    const parts = [
      { n: 1, status: 'downloaded' },
      { n: 2, status: 'pending' },
    ]
    const s = setup({ records: [record({ parts })] })
    await expect(
      s.service.deleteEngagement(owner, E, { ...good, deletionId: 'del-1' })
    ).rejects.toThrow(/Part 2 of 2 of the export did not finish/)
    noWrites(s)
  })

  it('deletes once every part is downloaded', async () => {
    const parts = [
      { n: 1, status: 'downloaded' },
      { n: 2, status: 'downloaded' },
    ]
    const s = setup({ records: [record({ parts })] })
    await s.service.deleteEngagement(owner, E, { ...good, deletionId: 'del-1' })
    expect(s.prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('refuses an export more than an hour old', async () => {
    const s = setup({ records: [record({ createdAt: new Date(Date.now() - 61 * 60 * 1000) })] })
    await expect(
      s.service.deleteEngagement(owner, E, { ...good, deletionId: 'del-1' })
    ).rejects.toThrow(/more than an hour old/)
    noWrites(s)
  })

  it('logs first, then removes the files, then the rows in one transaction, then the record', async () => {
    const s = setup({ records: [record({ createdAt: new Date(Date.now() - 59 * 60 * 1000) })] })
    await s.service.deleteEngagement(owner, E, { ...good, deletionId: 'del-1' })
    expect(s.log.log).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        workspaceId: W,
        resource: 'engagement',
        action: 'delete',
        subjectId: E,
        description: 'Deleted the engagement Coding Pathway permanently, after its full export',
      })
    )
    expect(s.calls).toEqual([
      'log',
      `files ${W}/${E}/`,
      'tx documents',
      'tx months',
      'tx engagement',
      'tx record',
      `files ${W}/${E}/`, // the sweep for a file that arrived while this ran
    ])
    expect(s.prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(s.tx.deletionRecord.update).toHaveBeenCalledWith({
      where: { id: 'del-1' },
      data: { status: 'deleted', deletedAt: expect.any(Date) },
    })
  })

  it('leaves the rows alone when the files cannot be removed, so the delete can be repeated', async () => {
    const s = setup()
    s.storage.deleteByPrefix.mockRejectedValueOnce(new Error('R2 down'))
    await expect(
      s.service.deleteEngagement(owner, E, { ...good, deletionId: 'del-1' })
    ).rejects.toThrow('R2 down')
    expect(s.prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('DeletionService: deleting a workspace', () => {
  const owner = member('owner')
  const body = { confirmName: workspace.name, confirmPhrase: DELETE_PHRASE }
  const wsRecord = (extra: Record<string, unknown> = {}) => record({ engagementId: null, ...extra })

  it('refuses while an engagement remains, whatever else is right', async () => {
    const s = setup({ engagements: 1, records: [wsRecord()], documents: 1 })
    await expect(
      s.service.deleteWorkspace(owner, W, { ...body, deletionId: 'del-1' })
    ).rejects.toThrow(ConflictException)
    await expect(s.service.exportWorkspace(owner, W)).rejects.toThrow(ConflictException)
    noWrites(s)
  })

  it.each([
    ['a wrong name', { ...body, confirmName: 'Riverbend' }],
    ['a wrong phrase', { ...body, confirmPhrase: 'Delete Permanently' }],
  ])('refuses %s', async (_, b) => {
    const s = setup({ records: [wsRecord()], documents: 1 })
    await expect(
      s.service.deleteWorkspace(owner, W, { ...b, deletionId: 'del-1' })
    ).rejects.toThrow(BadRequestException)
    noWrites(s)
  })

  it('needs an export when workspace documents exist, and it must be the workspace’s own', async () => {
    for (const records of [[], [record()], [wsRecord({ status: 'exported' })]]) {
      const s = setup({ records, documents: 2 })
      await expect(
        s.service.deleteWorkspace(owner, W, { ...body, deletionId: 'del-1' })
      ).rejects.toThrow(BadRequestException)
      await expect(s.service.deleteWorkspace(owner, W, body)).rejects.toThrow(BadRequestException)
      noWrites(s)
    }
  })

  it('deletes an empty workspace without an export, as trusted work after the files', async () => {
    const s = setup({ documents: 0 })
    await s.service.deleteWorkspace(owner, W, body)
    expect(s.calls).toEqual(['log', `files ${W}/`, 'tx documents', 'workspace', `files ${W}/`])
    expect(s.log.log).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        resource: 'workspace',
        action: 'delete',
        subjectId: W,
        description:
          'Deleted the workspace Riverbend Youth Services permanently, with no documents to export',
      })
    )
  })

  it('closes the export record when it deleted documents', async () => {
    const s = setup({ records: [wsRecord()], documents: 3 })
    await s.service.deleteWorkspace(owner, W, { ...body, deletionId: 'del-1' })
    expect(s.calls).toEqual([
      'log',
      `files ${W}/`,
      'tx documents',
      'tx record',
      'workspace',
      `files ${W}/`,
    ])
  })
})

describe('DeletionService: the export', () => {
  const owner = member('owner')
  const planOf = (
    objects: [string, string, number][] = [['pkg/a.pdf', 'key-a', 7]],
    personal: string[] = []
  ) => ({
    name: 'Coding Pathway - audit package.zip',
    files: objects.length,
    text: { 'pkg/Index.csv': strToU8('"a"') },
    objects,
    personalPaths: new Set(personal),
  })
  const part = (n: number, paths: string[], status = 'pending') => ({
    n,
    fileName: `Coding Pathway - audit package - part ${n} of 2.zip`,
    sourceBytes: 10,
    paths,
    key: `retained/${W}/${E}-part${n}-x.zip`,
    status,
  })

  /** A response that collects what is written, and can fail the way a dropped connection does. */
  function response(failAfter = Infinity) {
    const chunks: Buffer[] = []
    const res = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (chunks.length >= failAfter) return cb(new Error('socket hang up'))
        chunks.push(chunk)
        cb()
      },
    })
    res.on('error', () => undefined)
    return { res, bytes: () => Buffer.concat(chunks) }
  }

  function exporting(
    parts = [part(1, ['pkg/a.pdf'])],
    objects?: [string, string, number][],
    personal: string[] = []
  ) {
    const s = setup({ records: [record({ status: 'exported', parts })] })
    s.audit.plan.mockResolvedValue(planOf(objects, personal))
    s.storage.read.mockImplementation(async (key: string) => Buffer.from(`%PDF- ${key}`))
    return s
  }

  it('records the export with its parts and builds nothing yet', async () => {
    const s = setup()
    s.audit.plan.mockResolvedValue(
      planOf([
        ['pkg/a.pdf', 'key-a', 1_000_000_000],
        ['pkg/b.pdf', 'key-b', 1_000_000_000],
      ])
    )
    const made = await s.service.exportEngagement(owner, E)
    expect(s.audit.plan).toHaveBeenCalledWith(owner, E, { complete: true })
    expect(made.deletionId).toBe('del-new')
    expect(made.parts.map((p) => [p.n, p.fileName])).toEqual([
      [1, 'Coding Pathway - audit package - part 1 of 2.zip'],
      [2, 'Coding Pathway - audit package - part 2 of 2.zip'],
    ])
    const created = (
      s.prisma.deletionRecord.create.mock.calls as unknown as [
        { data: { exportKey: string; expiresAt: Date; parts: { key: string; status: string }[] } },
      ][]
    )[0][0].data
    expect(created).toMatchObject({
      workspaceId: W,
      engagementId: E,
      subjectName: 'Coding Pathway',
      deletedById: owner.userId,
      // Staff are named by email, never by display name.
      deletedByName: 'owner@ws-1.example.org',
    })
    expect(created.parts.map((p) => p.status)).toEqual(['pending', 'pending'])
    expect(created.parts[1]!.key).toMatch(
      new RegExp(`^retained/${W}/${E}-part2-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.zip$`)
    )
    const days = (created.expiresAt.getTime() - Date.now()) / 86_400_000
    expect(Math.round(days)).toBe(RETAINED_COPY_DAYS)
    expect(s.storage.putFile).not.toHaveBeenCalled()
    // Nothing has left yet: the line is written when a part is downloaded, so one click is one line.
    expect(s.log.log).not.toHaveBeenCalled()
  })

  it('logs each part download before a byte is built, in the words of the Download export button', async () => {
    const lines = (s: ReturnType<typeof setup>) =>
      (s.log.log.mock.calls as unknown as [unknown, { description: string }][]).map(
        ([, e]) => e.description
      )
    const one = exporting()
    one.storage.putFile.mockImplementation(async () => void one.calls.push('our copy'))
    await one.service.downloadEngagementPart(owner, E, 'del-1', 1)
    expect(lines(one)).toEqual([
      'Started downloading the full export of Coding Pathway before deleting it: 1 file',
    ])
    expect(one.log.log).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ workspaceId: W, resource: 'export', action: 'export' })
    )
    expect(one.calls).toEqual(['log', 'our copy'])
    // Personal records are named only when the part holds one; each part counts its own files.
    const two = exporting(
      [part(1, ['pkg/a.pdf']), part(2, ['pkg/b.pdf', 'pkg/c.pdf'])],
      [
        ['pkg/a.pdf', 'key-a', 7],
        ['pkg/b.pdf', 'key-b', 7],
        ['pkg/c.pdf', 'key-c', 7],
      ],
      ['pkg/c.pdf']
    )
    await two.service.downloadEngagementPart(owner, E, 'del-1', 1)
    await two.service.downloadEngagementPart(owner, E, 'del-1', 2)
    // A retry is a fresh line: each one says only that the download started.
    await two.service.downloadEngagementPart(owner, E, 'del-1', 2)
    expect(lines(two)).toEqual([
      'Started downloading part 1 of 2 of the full export of Coding Pathway before deleting it: 1 file',
      'Started downloading part 2 of 2 of the full export of Coding Pathway before deleting it: 2 files, personal records included',
      'Started downloading part 2 of 2 of the full export of Coding Pathway before deleting it: 2 files, personal records included',
    ])
    expect(JSON.stringify(two.log.log.mock.calls)).not.toContain('Downloaded')
  })

  it('builds a part, keeps our copy, reports the exact bytes, and marks the record when all parts are done', async () => {
    const s = exporting(
      [part(1, ['pkg/a.pdf'], 'downloaded'), part(2, [])].map((p, i) =>
        i ? { ...p, paths: [] } : p
      )
    )
    const file = await s.service.downloadEngagementPart(owner, E, 'del-1', 2)
    expect(file.fileName).toContain('part 2 of 2')
    const { res, bytes } = response()
    await file.send(res)
    const zip = unzipSync(new Uint8Array(bytes()))
    expect(Object.keys(zip)).toEqual(['PART.txt'])
    expect(strFromU8(zip['PART.txt']!)).toContain('PART 2 OF 2')
    expect(file.bytes).toBe(bytes().length)
    expect(file.sha256).toBe(createHash('sha256').update(bytes()).digest('hex'))
    expect(s.storage.putFile).toHaveBeenCalledWith(
      `retained/${W}/${E}-part2-x.zip`,
      expect.any(String),
      bytes().length,
      'application/zip'
    )
    const data = (
      s.prisma.deletionRecord.update.mock.calls as unknown as [{ data: Record<string, unknown> }][]
    )[0][0].data
    expect(data.status).toBe('downloaded')
    expect(data.parts).toEqual([
      expect.objectContaining({ n: 1, status: 'downloaded' }),
      expect.objectContaining({ n: 2, status: 'downloaded', bytes: bytes().length }),
    ])
  })

  it('keeps the record exported while another part is still to download', async () => {
    const s = exporting([part(1, ['pkg/a.pdf']), part(2, [])])
    const file = await s.service.downloadEngagementPart(owner, E, 'del-1', 1)
    const { res, bytes } = response()
    await file.send(res)
    const zip = unzipSync(new Uint8Array(bytes()))
    expect(Object.keys(zip).sort()).toEqual(['PART.txt', 'pkg/Index.csv', 'pkg/a.pdf'])
    const data = (
      s.prisma.deletionRecord.update.mock.calls as unknown as [{ data: Record<string, unknown> }][]
    )[0][0].data
    expect(data).not.toHaveProperty('status')
  })

  it('never marks a download that failed as downloaded', async () => {
    const s = exporting()
    const file = await s.service.downloadEngagementPart(owner, E, 'del-1', 1)
    const { res } = response(0)
    await file.send(res)
    expect(res.destroyed).toBe(true)
    expect(s.prisma.deletionRecord.update).not.toHaveBeenCalled()
  })

  it('refuses the part, with nothing sent, when our copy could not be kept', async () => {
    const s = exporting()
    s.storage.putFile.mockRejectedValue(new Error('R2 down'))
    await expect(s.service.downloadEngagementPart(owner, E, 'del-1', 1)).rejects.toThrow('R2 down')
    expect(s.prisma.deletionRecord.update).not.toHaveBeenCalled()
  })

  it('refuses a part that is not on the record, a record that is not this engagement’s, and a stale one', async () => {
    for (const n of [0, 3, 1.5, NaN]) {
      const s = exporting([part(1, ['pkg/a.pdf']), part(2, [])])
      await expect(s.service.downloadEngagementPart(owner, E, 'del-1', n)).rejects.toThrow(
        NotFoundException
      )
    }
    const other = setup({ records: [record({ engagementId: 'e-other', parts: [part(1, [])] })] })
    await expect(other.service.downloadEngagementPart(owner, E, 'del-1', 1)).rejects.toThrow(
      NotFoundException
    )
    const old = setup({
      records: [record({ createdAt: new Date(Date.now() - 61 * 60 * 1000), parts: [part(1, [])] })],
    })
    await expect(old.service.downloadEngagementPart(owner, E, 'del-1', 1)).rejects.toThrow(
      /more than an hour old/
    )
    const gone = setup({ records: [record({ status: 'deleted', parts: [part(1, [])] })] })
    await expect(gone.service.downloadEngagementPart(owner, E, 'del-1', 1)).rejects.toThrow(
      /already used/
    )
  })

  it('refuses when the records changed after the export was planned', async () => {
    const s = exporting(
      [part(1, ['pkg/a.pdf'])],
      [
        ['pkg/a.pdf', 'key-a', 7],
        ['pkg/new.pdf', 'key-new', 7],
      ]
    )
    await expect(s.service.downloadEngagementPart(owner, E, 'del-1', 1)).rejects.toThrow(
      ConflictException
    )
    expect(s.storage.putFile).not.toHaveBeenCalled()
  })

  it('exports a workspace’s own documents', async () => {
    const s = setup({ records: [record({ engagementId: null, status: 'exported', parts: [] })] })
    s.prisma.document.findMany.mockResolvedValue([
      {
        id: 'd-1',
        workspaceId: W,
        engagementId: null,
        storageKey: `${W}/workspace/general/a`,
        fileName: 'Insurance.pdf',
        kind: 'other',
        size: 15,
        uploadedAt: new Date('2026-09-01T00:00:00Z'),
      },
    ])
    s.storage.read.mockResolvedValue(Buffer.from('%PDF- insurance'))
    const made = await s.service.exportWorkspace(owner, W)
    expect(made.parts).toHaveLength(1)
    expect(made.parts[0]!.fileName).toBe('Riverbend Youth Services - workspace records.zip')
    expect(s.prisma.deletionRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ engagementId: null, subjectName: workspace.name }),
    })
    const parts = (
      s.prisma.deletionRecord.create.mock.calls as unknown as [{ data: { parts: unknown } }][]
    )[0][0].data.parts
    s.prisma.deletionRecord.findFirst.mockResolvedValue(
      record({ engagementId: null, subjectName: workspace.name, status: 'exported', parts })
    )
    const file = await s.service.downloadWorkspacePart(owner, W, 'del-1', 1)
    const { res, bytes } = response()
    await file.send(res)
    const zip = unzipSync(new Uint8Array(bytes()))
    expect(Object.keys(zip).sort()).toEqual([
      'Riverbend Youth Services - workspace records/Index.csv',
      'Riverbend Youth Services - workspace records/Insurance.pdf',
      'Riverbend Youth Services - workspace records/README.txt',
    ])
    const readme = strFromU8(zip['Riverbend Youth Services - workspace records/README.txt']!)
    expect(readme).toContain('by owner@ws-1.example.org from Audit Differently')
    expect(readme).not.toContain(owner.displayName)
    expect(s.log.log).toHaveBeenCalledTimes(1)
    expect(s.log.log).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        description:
          'Started downloading the full export of the workspace Riverbend Youth Services before deleting it: 1 file',
      })
    )
  })
})
