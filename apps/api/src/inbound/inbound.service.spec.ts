import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { InboundReceipt } from '@prisma/client'
import type { Role } from '@ad/types'
import type { Caller } from '../core/caller'
import { identifyCaller, tenantContext, withTenantContext } from '../core/tenant-context'
import { fakeLog } from '../core/testing/log'
import {
  BACKOFF_MINUTES,
  CLAIM_SQL,
  InboundService,
  MAX_ATTEMPTS,
  NO_ADDRESS,
  REJECT,
  STOPPED,
  namesCode,
} from './inbound.service'
import { ProviderError, type ReceivedAttachment, type ReceivedEmail } from './resend'

// What was read from each fictional receipt: its date is in the bytes, so a test says where each one goes.
jest.mock('../receipts/read-receipt', () => ({
  readReceipt: jest.fn(async (f: { buffer: Buffer }, withAi: boolean) => {
    const date = /date=(\d{4}-\d{2}-\d{2})/.exec(f.buffer.toString('latin1'))?.[1] ?? null
    return {
      amount: 12.5,
      date,
      vendor: 'Bright Path Office Supply',
      readBy: withAi ? 'ai' : 'text',
    }
  }),
}))

/**
 * Emailed receipts, start to end, with the email provider, the sender check and the filing mocked: the queue is
 * idempotent; an unknown address, an unverified sender (the provider's DMARC or ours), a non-member and an auditor are
 * refused; the engagement comes from the subject's code or the only active one, else it waits for a person; months
 * are drafts within the contract, started when missing; only PDF, PNG and JPG by their bytes, 10 at most, 10 MB each;
 * filing runs as the member, never as trusted work; a failure backs off and becomes final after five attempts; and a
 * person runs one again or files it by hand, logged.
 */
const W = 'ws-1'
const OTHER = 'ws-2'
const DOMAIN = 'receipts.example.org'

const pdf = (date?: string) =>
  Buffer.from(`%PDF-1.4 fictional receipt ${date ? `date=${date}` : ''}`)
const png = (size = 12 * 1024) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8),
  ])
const docx = () => Buffer.from('PK\x03\x04 a word file')

type Row = InboundReceipt
type Month = {
  id: string
  engagementId: string
  period: string
  status: string
  workspaceId: string
}

const people: Record<string, { email: string; role: Role; workspaceId: string }> = {
  'u-book': { email: 'bookkeeper@bright-path.example.org', role: 'bookkeeper', workspaceId: W },
  'u-owner': { email: 'owner@bright-path.example.org', role: 'owner', workspaceId: W },
  'u-aud': { email: 'auditor@bright-path.example.org', role: 'auditor', workspaceId: W },
  'u-other': { email: 'owner@harbor.example.org', role: 'owner', workspaceId: OTHER },
}
const callerOf = (userId: string): Caller => {
  const p = people[userId]!
  return {
    userId,
    displayName: p.email,
    email: p.email,
    memberships: [{ workspaceId: p.workspaceId, workspaceName: p.workspaceId, role: p.role }],
    workspaceIds: [p.workspaceId],
  }
}

function setup() {
  /** The workspace's owners' setting: off unless a test turns it on. */
  const settings = { readEmailedReceiptsWithAi: false }
  const rows: Row[] = []
  const months: Month[] = []
  let self: () => unknown = () => undefined
  const history = [
    {
      id: 'ra-now',
      address: 'bright-path',
      workspaceId: W,
      firstUsedAt: new Date('2026-08-01T00:00:00Z'),
      removedAt: null as Date | null,
      releasedAt: null as Date | null,
    },
    {
      id: 'ra-old',
      address: 'bright-old',
      workspaceId: W,
      firstUsedAt: new Date('2026-06-01T00:00:00Z'),
      removedAt: new Date('2026-09-01T00:00:00Z') as Date | null,
      releasedAt: null as Date | null,
    },
  ]
  const engagements = [
    {
      id: 'e-cp',
      workspaceId: W,
      name: 'Coding Pathway',
      code: 'CP26',
      status: 'active',
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2027-06-30T00:00:00Z'),
    },
    {
      id: 'e-yb',
      workspaceId: W,
      name: 'Youth Bridge',
      code: 'YB',
      status: 'proposed',
      periodStart: null as Date | null,
      periodEnd: null as Date | null,
    },
  ]
  const contexts: { what: string; ctx: ReturnType<typeof tenantContext> }[] = []
  const seen = (what: string) => contexts.push({ what, ctx: { ...(tenantContext() ?? {}) } })
  const visible = (ws: string | null) => {
    const ctx = tenantContext()
    if (ctx?.allWorkspaces) return true
    const ids = ctx?.userId ? callerOf(ctx.userId).workspaceIds : []
    return !!ws && ids.includes(ws)
  }
  const apply = (r: Row, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'push' in v)
        (r as unknown as Record<string, unknown[]>)[k] = [
          ...((r as unknown as Record<string, unknown[]>)[k] ?? []),
          (v as { push: unknown }).push,
        ]
      else (r as unknown as Record<string, unknown>)[k] = v
    }
  }
  const prisma = {
    inboundReceipt: {
      createMany: jest.fn(async ({ data }: { data: Partial<Row>[] }) => {
        seen('enqueue')
        let count = 0
        for (const d of data) {
          if (rows.some((r) => r.emailId === d.emailId)) continue
          rows.push({
            id: `ir-${rows.length + 1}`,
            status: 'received',
            attempts: 0,
            nextAttemptAt: new Date(),
            error: null,
            workspaceId: null,
            senderUserId: null,
            engagementId: null,
            documentIds: [],
            filedAttachments: [],
            rejectReason: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            fromAddress: null,
            toAddress: null,
            subject: null,
            ...d,
          } as Row)
          count++
        }
        return { count }
      }),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = rows.find((x) => x.id === where.id)
        return r && visible(r.workspaceId) ? r : null
      }),
      findMany: jest.fn(async () =>
        rows
          .filter((r) => visible(r.workspaceId) && r.workspaceId)
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          seen('update')
          const r = rows.find((x) => x.id === where.id)!
          if (!visible(r.workspaceId) && r.workspaceId) throw new Error('row-level security')
          apply(r, data)
          return r
        }
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: string }
          data: Record<string, unknown>
        }) => {
          const r = rows.find((x) => x.id === where.id && x.status === where.status)
          if (!r || !visible(r.workspaceId)) return { count: 0 }
          apply(r, data)
          return { count: 1 }
        }
      ),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    // The worker's pass, as the SQL does it: what a stopped process left is given up, then what is due is claimed.
    $executeRawUnsafe: jest.fn(
      async (_sql: string, max: number, reason: string, noAddress: string) => {
        for (const r of rows.filter((x) => x.nextAttemptAt <= new Date())) {
          if (r.status === 'filing') r.status = 'unmatched'
          else if (r.status === 'processing' && r.attempts >= max)
            Object.assign(r, { status: 'failed', error: reason })
        }
        // A row queued with no receipts address is never claimed: after a day it fails.
        for (const r of rows)
          if (
            r.status === 'received' &&
            !r.toAddress &&
            r.createdAt.getTime() <= Date.now() - 86_400_000
          )
            Object.assign(r, { status: 'failed', error: noAddress })
        return 0
      }
    ),
    $queryRawUnsafe: jest.fn(
      async (sql: string, limit: string | number, max?: number, domain?: string) => {
        // The filing transaction's locked read of the row.
        if (sql !== CLAIM_SQL) {
          const r = rows.find((x) => x.id === limit)
          return r ? [{ filedAttachments: [...r.filedAttachments] }] : []
        }
        seen('claim')
        const due = rows
          .filter(
            (r) =>
              ['received', 'processing'].includes(r.status) &&
              r.nextAttemptAt <= new Date() &&
              r.attempts < max! &&
              !!r.toAddress?.toLowerCase().endsWith(`@${domain}`)
          )
          .slice(0, Number(limit))
        for (const r of due) {
          r.status = 'processing'
          r.attempts++
          r.nextAttemptAt = new Date(Date.now() + 15 * 60_000)
        }
        return due.map((r) => ({ ...r }))
      }
    ),
    // Every receipts address used: Bright Path's current one, and one it used before. Asked two ways: a previously
    // used address not released, and the current row a workspace holds an address by.
    receiptsAddress: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { address: string; workspaceId?: string; removedAt: null | { not: null } }
        }) => {
          seen('history')
          const r = history.find((h) =>
            where.removedAt === null
              ? h.address === where.address && h.workspaceId === where.workspaceId && !h.removedAt
              : h.address === where.address && h.removedAt && !h.releasedAt
          )
          return r ? { id: r.id, firstUsedAt: r.firstUsedAt } : null
        }
      ),
    },
    // An interactive transaction runs on the same fakes.
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
      fn(self())
    ),
    workspace: {
      findFirst: jest.fn(
        async ({ where }: { where: { receiptsAddress?: string; id?: string } }) => {
          seen('workspace')
          if (where.receiptsAddress === 'bright-path')
            return { id: W, receiptsAddress: 'bright-path' }
          if (where.id === W) return { id: W, receiptsAddress: 'bright-path', ...settings }
          return null
        }
      ),
    },
    user: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            email: { equals: string }
            memberships: { some: { workspaceId: string; role: { in: string[] } } }
          }
        }) => {
          seen('sender')
          const { workspaceId, role } = where.memberships.some
          return Object.entries(people)
            .filter(
              ([, p]) =>
                p.email === where.email.equals &&
                p.workspaceId === workspaceId &&
                role.in.includes(p.role)
            )
            .map(([id]) => ({ id }))
        }
      ),
    },
    engagement: {
      findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        engagements.filter(
          (e) => visible(e.workspaceId) && (!where.id || where.id.in.includes(e.id))
        )
      ),
    },
    monthlyReport: {
      findMany: jest.fn(
        async ({ where }: { where: { engagementId: string; period: { in: string[] } } }) =>
          months.filter(
            (m) => m.engagementId === where.engagementId && where.period.in.includes(m.period)
          )
      ),
    },
  }
  self = () => prisma
  const log = fakeLog(prisma)
  const callers = { load: jest.fn(async (id: string) => callerOf(id)) }
  const clerk = {
    verifiedEmails: jest.fn(async (id: string) => (people[id] ? [people[id]!.email] : [])),
  }
  const filed: {
    reportId: string
    name: string
    description: string
    userId?: string
    system?: boolean
  }[] = []
  let docs = 0
  const receipts = {
    fileOne: jest.fn(
      async (
        caller: Caller,
        reportId: string,
        file: { originalname: string },
        _read: unknown,
        description: (m: { kind: string; sensitivity: string; period: string | null }) => string,
        alsoInTx: (tx: unknown, id: string) => Promise<unknown>
      ) => {
        const ctx = tenantContext()
        const m = months.find((x) => x.id === reportId)!
        if (m.status !== 'draft') throw new ConflictException('locked')
        const id = `doc-${++docs}`
        await alsoInTx(prisma, id)
        filed.push({
          reportId,
          name: file.originalname,
          description: description({ kind: 'receipt', sensitivity: 'financial', period: m.period }),
          userId: ctx?.userId,
          system: ctx?.allWorkspaces,
        })
        expect(caller.userId).toBe(ctx?.userId)
        return { documentId: id, matched: false }
      }
    ),
  }
  const engagementsService = {
    createReport: jest.fn(async (caller: Caller, engagementId: string, period: string) => {
      months.push({ id: `r-${period}`, engagementId, period, status: 'draft', workspaceId: W })
      return { id: `r-${period}` }
    }),
  }
  let email: Partial<ReceivedEmail> = {}
  let attachments: ReceivedAttachment[] = []
  const blobs = new Map<string, Buffer>()
  const resend = {
    email: jest.fn(async () => email as ReceivedEmail),
    attachments: jest.fn(async () => attachments),
    download: jest.fn(async (url: string, max: number) => {
      const b = blobs.get(url) ?? Buffer.from('raw message')
      return b.length > max ? null : b
    }),
  }
  const senders = {
    verify: jest.fn(async () => ({ ...VERDICT })),
  }
  // Matching statistics: each row with the context it was written in.
  const statRows: { row: Record<string, unknown>; userId?: string; system?: boolean }[] = []
  const stats = {
    record: jest.fn(async (row: Record<string, unknown>) => {
      const ctx = tenantContext()
      statRows.push({ row, userId: ctx?.userId, system: ctx?.allWorkspaces })
    }),
  }
  const s = new InboundService(
    prisma as never,
    log as never,
    callers as never,
    clerk as never,
    receipts as never,
    engagementsService as never,
    resend as never,
    senders as never,
    stats as never
  )
  const attach = (id: string, filename: string, buffer: Buffer, size = buffer.length) => {
    blobs.set(`https://inbound.example.org/${id}`, buffer)
    attachments.push({
      id,
      filename,
      content_type: 'application/octet-stream',
      size,
      download_url: `https://inbound.example.org/${id}`,
    })
  }
  const set = {
    email: (e: Partial<ReceivedEmail>) => (email = e),
    noAttachments: () => (attachments = []),
  }
  /** Queues one email, as the webhook does, and runs the worker once. */
  const receive = async (
    subject = 'Receipt CP26',
    from = 'Pat Bookkeeper <bookkeeper@bright-path.example.org>',
    to = `bright-path@${DOMAIN}`,
    created_at = '2026-09-20T15:00:00Z'
  ) => {
    await s.enqueue({
      type: 'email.received',
      data: { email_id: `em-${rows.length + 1}`, from, to: [to], subject, created_at },
    })
    await s.runDue()
    return rows[rows.length - 1]!
  }
  return {
    s,
    rows,
    history,
    settings,
    get attachments() {
      return attachments
    },
    months,
    engagements,
    contexts,
    log,
    clerk,
    resend,
    senders,
    receipts,
    engagementsService,
    filed,
    attach,
    set,
    receive,
    statRows,
  }
}

/** As a signed-in request runs: its own context, filled in by the guard. */
const asRequest = <T>(userId: string, fn: (c: Caller) => Promise<T>): Promise<T> =>
  withTenantContext(() => {
    identifyCaller({ userId })
    return fn(callerOf(userId))
  })

/** Our own check's answer for a good email: signed by the From domain, to the receipts address, one To, one Subject. */
const VERDICT = {
  dmarcPass: true,
  headerFrom: ['bookkeeper@bright-path.example.org'],
  toHeaders: 1,
  subjectHeaders: 1,
  signedRecipients: ['bright-path@receipts.example.org'],
}

const GOOD: Partial<ReceivedEmail> = {
  authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  raw: { download_url: 'https://inbound.example.org/raw' },
}

describe('emailed receipts', () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.RESEND_RECEIVING_API_KEY = 're_test_fictional'
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_ZmljdGlvbmFs'
    process.env.RECEIPTS_DOMAIN = DOMAIN
  })
  afterEach(() => {
    process.env = { ...env }
  })

  const ready = () => {
    const t = setup()
    t.set.email(GOOD)
    t.attach('att-1', 'bright-path-office-supply.pdf', pdf('2026-09-02'))
    return t
  }

  describe('the queue', () => {
    it('queues one row per provider email id, with no workspace, as trusted work', async () => {
      const t = setup()
      const event = {
        type: 'email.received',
        data: {
          email_id: 'em-1',
          from: 'Pat <Bookkeeper@Bright-Path.example.org>',
          to: [`bright-path@${DOMAIN}`],
          subject: 'Receipt CP26',
          created_at: '2026-09-20T15:00:00Z',
        },
      }
      await t.s.enqueue(event)
      await t.s.enqueue(event)
      expect(t.rows).toHaveLength(1)
      expect(t.rows[0]).toMatchObject({
        emailId: 'em-1',
        status: 'received',
        workspaceId: null,
        fromAddress: 'bookkeeper@bright-path.example.org',
        toAddress: `bright-path@${DOMAIN}`,
      })
      expect(
        t.contexts.filter((c) => c.what === 'enqueue').every((c) => c.ctx?.allWorkspaces)
      ).toBe(true)
    })

    it("ignores and keeps nothing of an email to another receipts domain (the other environment's)", async () => {
      const t = setup()
      await expect(
        t.s.enqueue({
          type: 'email.received',
          data: {
            email_id: 'em-other',
            from: 'pat@bright-path.example.org',
            to: ['bright-path@receipts-other.example.org'],
            subject: 'Receipt CP26',
          },
        })
      ).resolves.toBe(false)
      expect(t.rows).toHaveLength(0)
    })

    it('ignores any other event type, so the provider never retries it', async () => {
      const t = setup()
      await expect(t.s.enqueue({ type: 'email.sent', data: { email_id: 'em-1' } })).resolves.toBe(
        false
      )
      expect(t.rows).toHaveLength(0)
    })

    it('is off, a 404, until the email provider is set up', async () => {
      delete process.env.RECEIPTS_DOMAIN
      const t = setup()
      await expect(
        t.s.enqueue({ type: 'email.received', data: { email_id: 'x' } })
      ).rejects.toThrow(NotFoundException)
    })
  })

  describe('refusals', () => {
    it('refuses an address a workspace used before, keeps it once, and keeps no sender or subject', async () => {
      const t = ready()
      const event = {
        type: 'email.received',
        data: {
          email_id: 'em-old',
          from: 'Vendor <billing@vendor.example.org>',
          to: [`bright-old@${DOMAIN}`],
          subject: 'Invoice 1042',
          created_at: '2026-09-20T15:00:00Z',
        },
      }
      await expect(t.s.enqueue(event)).resolves.toBe(true)
      // The provider calls again: nothing more is kept or counted.
      await t.s.enqueue(event)
      await t.s.runDue()
      expect(t.rows).toHaveLength(1)
      expect(t.rows[0]).toMatchObject({
        status: 'rejected',
        rejectReason: REJECT.retired,
        workspaceId: null,
        toAddress: `bright-old@${DOMAIN}`,
        fromAddress: null,
        subject: null,
      })
      // Counted from that row by Admin tools (never a stored count), and nothing was fetched from the provider.
      expect(t.rows[0]!.receivedAt).toEqual(new Date('2026-09-20T15:00:00Z'))
      expect(t.resend.email).not.toHaveBeenCalled()
      // All of it as trusted work, before anyone is known.
      expect(
        t.contexts
          .filter((c) => ['enqueue', 'history'].includes(c.what))
          .every((c) => c.ctx?.allWorkspaces && !c.ctx.userId)
      ).toBe(true)
    })

    it('refuses as no longer in use an email queued before its address changed, kept as it came', async () => {
      const t = ready()
      // Queued while bright-old was still current, then the owner changed the address.
      const old = t.history.find((h) => h.id === 'ra-old')!
      const removedAt = old.removedAt
      old.removedAt = null
      await t.s.enqueue({
        type: 'email.received',
        data: {
          email_id: 'em-q',
          from: 'bookkeeper@bright-path.example.org',
          to: [`bright-old@${DOMAIN}`],
        },
      })
      old.removedAt = removedAt
      await t.s.runDue()
      // Its sender stays, so it is not one of the refused emails Admin tools counts, and it goes with the clean-up.
      expect(t.rows[0]).toMatchObject({
        status: 'rejected',
        rejectReason: REJECT.retired,
        fromAddress: 'bookkeeper@bright-path.example.org',
      })
    })

    it('never files an email into a workspace that took its address after it arrived', async () => {
      const t = ready()
      // Queued on 20 September while another workspace held bright-path; that address was released, and this
      // workspace chose it on 25 September, before the worker got to the email.
      t.history.find((h) => h.id === 'ra-now')!.firstUsedAt = new Date('2026-09-25T00:00:00Z')
      const row = await t.receive('Receipt CP26', undefined, undefined, '2026-09-20T15:00:00Z')
      expect(row).toMatchObject({
        status: 'rejected',
        rejectReason: REJECT.retired,
        workspaceId: null,
      })
      expect(t.resend.email).not.toHaveBeenCalled()
      // One that arrived after the workspace took it is its own.
      const later = await t.receive('Receipt CP26', undefined, undefined, '2026-09-26T09:00:00Z')
      expect(later).toMatchObject({ status: 'filed', workspaceId: W })
    })

    it('queues mail to a released address like any unknown one, never as no longer in use', async () => {
      const t = ready()
      t.history.find((h) => h.id === 'ra-old')!.releasedAt = new Date('2026-10-01T00:00:00Z')
      const row = await t.receive('Receipt', undefined, `bright-old@${DOMAIN}`)
      expect(row).toMatchObject({ status: 'rejected', rejectReason: REJECT.noAddress })
    })

    it('refuses an address no workspace has, and keeps it to trusted work', async () => {
      const t = ready()
      const row = await t.receive('Receipt', undefined, `nobody-here@${DOMAIN}`)
      expect(row).toMatchObject({
        status: 'rejected',
        rejectReason: REJECT.noAddress,
        workspaceId: null,
      })
      expect(t.resend.email).not.toHaveBeenCalled()
    })

    it('refuses a sender the provider could not verify: DMARC not a pass, or no result at all', async () => {
      for (const authentication of [{ dmarc: 'fail' }, { dmarc: 'unknown' }, null]) {
        const t = ready()
        t.set.email({ ...GOOD, authentication })
        const row = await t.receive()
        // Not verified: the row names no workspace, so it stays trusted work's and is purged.
        expect(row).toMatchObject({
          status: 'rejected',
          rejectReason: REJECT.unverified,
          workspaceId: null,
          senderUserId: null,
        })
        expect(t.receipts.fileOne).not.toHaveBeenCalled()
      }
    })

    it('refuses a sender our own check does not pass, or whose From line is someone else', async () => {
      for (const verdict of [
        { ...VERDICT, dmarcPass: false },
        { ...VERDICT, headerFrom: ['someone@elsewhere.example.org'] },
        { ...VERDICT, headerFrom: [] },
      ]) {
        const t = ready()
        t.senders.verify.mockResolvedValueOnce(verdict)
        const row = await t.receive()
        expect(row).toMatchObject({
          status: 'rejected',
          rejectReason: REJECT.unverified,
          workspaceId: null,
        })
        expect(t.receipts.fileOne).not.toHaveBeenCalled()
      }
    })

    it('refuses a signed message replayed under another To or Subject, or not signed for the receipts address', async () => {
      for (const verdict of [
        { ...VERDICT, toHeaders: 2 },
        { ...VERDICT, subjectHeaders: 2 },
        { ...VERDICT, signedRecipients: [] },
        { ...VERDICT, signedRecipients: ['someone@elsewhere.example.org'] },
      ]) {
        const t = ready()
        t.senders.verify.mockResolvedValueOnce(verdict)
        expect(await t.receive()).toMatchObject({
          status: 'rejected',
          rejectReason: REJECT.unverified,
          workspaceId: null,
        })
        expect(t.receipts.fileOne).not.toHaveBeenCalled()
      }
    })

    it('refuses anyone but an owner or bookkeeper of the workspace, by a verified email', async () => {
      for (const from of [
        'stranger@elsewhere.example.org',
        'auditor@bright-path.example.org',
        'owner@harbor.example.org',
      ]) {
        const t = ready()
        const row = await t.receive('Receipt CP26', from)
        expect(row).toMatchObject({
          status: 'rejected',
          rejectReason: REJECT.notMember,
          workspaceId: null,
        })
        // Found out before anything is fetched from the provider.
        expect(t.resend.email).not.toHaveBeenCalled()
        expect(t.resend.download).not.toHaveBeenCalled()
      }
      // A member whose address is no longer verified at Clerk.
      const t = ready()
      t.clerk.verifiedEmails.mockResolvedValueOnce([])
      expect(await t.receive()).toMatchObject({
        status: 'rejected',
        rejectReason: REJECT.notMember,
      })
    })

    it('writes no access-log line for a refusal: there is no caller', async () => {
      const t = ready()
      t.set.email({ ...GOOD, authentication: null })
      await t.receive()
      expect(t.log.entries).toEqual([])
    })
  })

  describe('filing', () => {
    it('files into the engagement the subject names by code, any case, as the member and never as trusted work', async () => {
      const t = ready()
      t.engagements[1]!.status = 'active'
      const row = await t.receive('fwd: receipt for cp26, thanks')
      expect(row).toMatchObject({
        status: 'filed',
        engagementId: 'e-cp',
        senderUserId: 'u-book',
        documentIds: ['doc-1'],
        filedAttachments: ['att-1'],
      })
      expect(t.engagementsService.createReport).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-book' }),
        'e-cp',
        '2026-09'
      )
      expect(t.filed).toEqual([
        {
          reportId: 'r-2026-09',
          name: 'bright-path-office-supply.pdf',
          description: 'Emailed in a receipt for September 2026 of Coding Pathway',
          userId: 'u-book',
          system: false,
        },
      ])
    })

    it("reads with AI only when the workspace's owners turned it on, and the line says so", async () => {
      const reader = jest.requireMock<{ readReceipt: jest.Mock }>('../receipts/read-receipt')
      reader.readReceipt.mockClear()
      const off = ready()
      await off.receive('Receipt CP26')
      expect(reader.readReceipt.mock.calls.map((c) => c[1])).toEqual([false])
      expect(off.filed[0]!.description).toBe(
        'Emailed in a receipt for September 2026 of Coding Pathway'
      )

      reader.readReceipt.mockClear()
      const on = ready()
      on.settings.readEmailedReceiptsWithAi = true
      await on.receive('Receipt CP26')
      expect(reader.readReceipt.mock.calls.map((c) => c[1])).toEqual([true])
      expect(on.filed[0]!.description).toBe(
        'Emailed in a receipt for September 2026 of Coding Pathway, read with AI'
      )
    })

    it('uses the only active engagement when the subject names none, and waits for a person otherwise', async () => {
      const one = ready()
      expect(await one.receive('Lunch receipt')).toMatchObject({
        status: 'filed',
        engagementId: 'e-cp',
      })

      const two = ready()
      two.engagements[1]!.status = 'active'
      expect(await two.receive('Lunch receipt')).toMatchObject({
        status: 'unmatched',
        rejectReason: 'No engagement code in the subject, and 2 engagements are active',
      })
      expect(two.receipts.fileOne).not.toHaveBeenCalled()
    })

    it('matches a code as a whole word only', () => {
      expect(namesCode('Receipt CP26', 'CP26')).toBe(true)
      expect(namesCode('cp26: lunch', 'CP26')).toBe(true)
      expect(namesCode('Receipt CP265', 'CP26')).toBe(false)
      expect(namesCode('Receipt XCP26', 'CP26')).toBe(false)
      expect(namesCode('Receipt CP26-B', 'CP26')).toBe(false)
      expect(namesCode(null, 'CP26')).toBe(false)
    })

    it('puts a receipt with no date read into the month the email arrived, into an existing draft', async () => {
      const t = setup()
      t.set.email(GOOD)
      t.attach('att-1', 'photo.png', png())
      t.months.push({
        id: 'r-2026-10',
        engagementId: 'e-cp',
        period: '2026-10',
        status: 'draft',
        workspaceId: W,
      })
      const row = await t.receive('CP26', undefined, undefined, '2026-10-03T09:00:00Z')
      expect(row.status).toBe('filed')
      expect(t.engagementsService.createReport).not.toHaveBeenCalled()
      expect(t.filed[0]).toMatchObject({ reportId: 'r-2026-10', name: 'photo.png' })
    })

    it('leaves it unmatched, with the reason, for a closed or submitted month or a date outside the contract', async () => {
      const closed = ready()
      closed.months.push({
        id: 'r-2026-09',
        engagementId: 'e-cp',
        period: '2026-09',
        status: 'closed',
        workspaceId: W,
      })
      expect(await closed.receive()).toMatchObject({
        status: 'unmatched',
        rejectReason: 'September 2026 of Coding Pathway is closed',
        engagementId: 'e-cp',
      })
      expect(closed.receipts.fileOne).not.toHaveBeenCalled()

      const early = setup()
      early.set.email(GOOD)
      early.attach('att-1', 'old.pdf', pdf('2026-05-30'))
      expect(await early.receive()).toMatchObject({
        status: 'unmatched',
        rejectReason: 'May 2026 is outside the contract period of Coding Pathway',
      })

      const noPeriod = ready()
      expect(await noPeriod.receive('Receipt YB')).toMatchObject({
        status: 'unmatched',
        rejectReason: 'Youth Bridge has no contract period yet',
      })
    })

    it('files only PDF, PNG and JPG by their bytes, 10 MB each, downloads 10 at most, and lists the rest as skipped', async () => {
      const t = setup()
      t.set.email(GOOD)
      t.attach('att-doc', 'notes.pdf', docx())
      t.attach('att-big', 'huge.pdf', pdf('2026-09-02'), 11 * 1024 * 1024)
      for (let i = 1; i <= 11; i++) t.attach(`att-${i}`, `r${i}.pdf`, pdf('2026-09-02'))
      const row = await t.receive()
      expect(row.status).toBe('filed')
      // notes.pdf was downloaded too: 10 downloads in all, whatever they turn out to be.
      expect(row.documentIds).toHaveLength(9)
      expect(t.resend.download).toHaveBeenCalledTimes(11) // the raw message, and 10 attachments
      expect(row.error).toBe(
        'Skipped: notes.pdf (not a PDF, PNG or JPG); huge.pdf (over 10 MB); r10.pdf (more than 10 attachments); r11.pdf (more than 10 attachments)'
      )
    })

    it('passes over pictures in the body and small images: a logo is not a receipt', async () => {
      const t = ready()
      t.attach('att-logo', 'logo.png', png())
      t.attachments.at(-1)!.content_disposition = 'inline'
      t.attach('att-icon', 'icon.png', png(2048))
      t.attachments.at(-1)!.content_type = 'image/png'
      t.attach('att-sig', 'signature.png', png(4096))
      const row = await t.receive()
      expect(row).toMatchObject({ status: 'filed', filedAttachments: ['att-1'], error: null })
      // Neither the inline logo nor the icon (its size is given) is downloaded.
      expect(t.resend.download).toHaveBeenCalledTimes(3)
    })

    it('refuses an email with nothing that can be a receipt', async () => {
      const t = setup()
      t.set.email(GOOD)
      t.attach('att-doc', 'letter.docx', docx())
      expect(await t.receive()).toMatchObject({ status: 'rejected', rejectReason: REJECT.noFiles })
    })
  })

  describe('retries', () => {
    it('never claims a row past its last attempt: one a crash left behind fails for good', async () => {
      const t = ready()
      await t.s.enqueue({
        type: 'email.received',
        data: {
          email_id: 'em-x',
          from: 'bookkeeper@bright-path.example.org',
          to: [`bright-path@${DOMAIN}`],
        },
      })
      const row = t.rows[0]!
      // A worker took it a fifth time and the process died: the row is left "processing" with its lease run out.
      Object.assign(row, {
        status: 'processing',
        attempts: MAX_ATTEMPTS,
        nextAttemptAt: new Date(0),
      })
      expect(await t.s.runDue()).toBe(0)
      expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, error: STOPPED })
      expect(t.resend.email).not.toHaveBeenCalled()
    })

    it('ends a row queued with no receipts address once it is a day old, and leaves a newer one', async () => {
      const t = ready()
      for (const id of ['em-old', 'em-new'])
        await t.s.enqueue({
          type: 'email.received',
          data: { email_id: id, from: 'bookkeeper@bright-path.example.org', to: [`x@${DOMAIN}`] },
        })
      // Queued before the webhook kept only mail to its own domain: no receipts address.
      for (const r of t.rows) r.toAddress = null
      t.rows[0]!.createdAt = new Date(Date.now() - 2 * 86_400_000)
      expect(await t.s.runDue()).toBe(0)
      expect(t.rows.map((r) => [r.emailId, r.status, r.error])).toEqual([
        ['em-old', 'failed', NO_ADDRESS],
        ['em-new', 'received', null],
      ])
    })

    it('files nothing another worker filed while its lease overlapped', async () => {
      const t = ready()
      t.attach('att-2', 'second.pdf', pdf('2026-09-03'))
      // While this worker reads the files, another one holding the row files the first.
      t.resend.attachments.mockImplementationOnce(async () => {
        t.rows[0]!.filedAttachments = [...t.rows[0]!.filedAttachments, 'att-1']
        return t.attachments
      })
      const row = await t.receive()
      expect(row).toMatchObject({ status: 'filed', filedAttachments: ['att-1', 'att-2'] })
      expect(t.filed.map((f) => f.name)).toEqual(['second.pdf'])
    })

    it('backs off after a failure, 1, 5, 15 and 60 minutes, and fails for good after five attempts', async () => {
      const t = ready()
      t.resend.email.mockRejectedValue(new ProviderError('The email provider answered 503'))
      const row = await t.receive()
      expect(row).toMatchObject({ status: 'received', attempts: 1 })
      const waits: number[] = []
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        waits.push(Math.round((row.nextAttemptAt.getTime() - Date.now()) / 60_000))
        row.nextAttemptAt = new Date(Date.now() - 1)
        await t.s.runDue()
      }
      expect(waits).toEqual(BACKOFF_MINUTES)
      expect(row).toMatchObject({
        status: 'failed',
        attempts: MAX_ATTEMPTS,
        error: 'The email provider answered 503',
      })
    })

    it('counts each filing for Matching statistics, as the member: counts and sizes, never a name or an amount', async () => {
      const t = ready()
      t.engagements[1]!.status = 'active'
      await t.receive()
      expect(t.statRows).toEqual([
        {
          row: expect.objectContaining({
            workspaceId: W,
            feature: 'emailed-receipts',
            startedById: 'u-book',
            outcome: 'done',
            fileCount: 1,
            items: 1,
            matched: 0,
            missing: 1,
            failed: 0,
          }),
          userId: 'u-book',
          system: false,
        },
      ])
      const text = JSON.stringify(t.statRows[0]!.row)
      for (const secret of ['.pdf', 'Bright Path', '12.5', 'doc-1', 'att-1', 'e-cp', 'CP26'])
        expect(text).not.toContain(secret)
    })

    it('counts a filing that failed part way, and none for a refused email', async () => {
      const t = ready()
      t.receipts.fileOne.mockRejectedValueOnce(new ProviderError('The email provider answered 500'))
      await t.receive()
      expect(t.statRows.map((r) => r.row.outcome)).toEqual(['failed'])
      const u = setup()
      u.set.email({ ...GOOD, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'fail' } })
      await u.receive()
      expect(u.statRows).toEqual([])
    })

    it('files no attachment twice when a later one fails and the email is tried again', async () => {
      const t = ready()
      t.attach('att-2', 'second.pdf', pdf('2026-09-03'))
      t.receipts.fileOne.mockImplementationOnce(t.receipts.fileOne.getMockImplementation()!)
      t.receipts.fileOne.mockRejectedValueOnce(new ProviderError('The email provider answered 500'))
      const row = await t.receive()
      expect(row).toMatchObject({ status: 'received', filedAttachments: ['att-1'] })
      row.nextAttemptAt = new Date(Date.now() - 1)
      await t.s.runDue()
      expect(row).toMatchObject({ status: 'filed', filedAttachments: ['att-1', 'att-2'] })
      expect(t.filed.map((f) => f.name)).toEqual(['bright-path-office-supply.pdf', 'second.pdf'])
    })
  })

  describe('the receipts inbox', () => {
    // Failed after the sender was verified, so the row is the workspace's.
    const failed = async () => {
      const t = ready()
      t.resend.attachments.mockRejectedValue(new ProviderError('The email provider answered 503'))
      const row = await t.receive()
      expect(row.workspaceId).toBe(W)
      Object.assign(row, { status: 'failed', attempts: 5 })
      t.resend.attachments.mockImplementation(async () => t.attachments)
      return { t, row }
    }

    it('shows the address and the workspace rows, newest first, to every member', async () => {
      const t = ready()
      await t.receive('Receipt CP26', undefined, undefined, '2026-09-20T15:00:00Z')
      await t.receive('Receipt CP26', undefined, undefined, '2026-09-21T15:00:00Z')
      await t.receive('Receipt', undefined, `nobody-here@${DOMAIN}`)
      const inbox = await asRequest('u-aud', (c) => t.s.inbox(c, W))
      expect(inbox.address).toBe(`bright-path@${DOMAIN}`)
      expect(inbox.configured).toBe(true)
      expect(inbox.canManage).toBe(false)
      expect(inbox.items.map((i) => i.receivedAt)).toEqual([
        '2026-09-21T15:00:00.000Z',
        '2026-09-20T15:00:00.000Z',
      ])
      expect(inbox.items[0]).toMatchObject({
        status: 'filed',
        engagementName: 'Coding Pathway',
        documentCount: 1,
      })
      await expect(asRequest('u-other', (c) => t.s.inbox(c, W))).rejects.toThrow(NotFoundException)
    })

    it('runs a failed receipt again, logged, for an owner or bookkeeper only', async () => {
      const { t, row } = await failed()
      await expect(asRequest('u-aud', (c) => t.s.runAgain(c, row.id))).rejects.toThrow(
        ForbiddenException
      )
      await expect(asRequest('u-other', (c) => t.s.runAgain(c, row.id))).rejects.toThrow(
        NotFoundException
      )
      await asRequest('u-owner', (c) => t.s.runAgain(c, row.id))
      expect(row).toMatchObject({ status: 'received', attempts: 0, error: null })
      expect(t.log.entries.at(-1)).toMatchObject({
        workspaceId: W,
        description: 'Ran an emailed receipt again from the receipts inbox',
        changes: [{ field: 'Status', before: 'failed', after: 'received' }],
      })
      await t.s.runDue()
      expect(row.status).toBe('filed')
      await expect(asRequest('u-owner', (c) => t.s.runAgain(c, row.id))).rejects.toThrow(
        ConflictException
      )
    })

    it('dismisses a receipt that needs filing, with its reason, logged, for an owner or bookkeeper only', async () => {
      const t = ready()
      t.engagements[1]!.status = 'active'
      const row = await t.receive('Lunch receipt')
      expect(row.status).toBe('unmatched')
      await expect(asRequest('u-aud', (c) => t.s.dismiss(c, row.id, 'personal'))).rejects.toThrow(
        ForbiddenException
      )
      await expect(asRequest('u-owner', (c) => t.s.dismiss(c, row.id, 'because'))).rejects.toThrow(
        /Say why/
      )
      await asRequest('u-owner', (c) => t.s.dismiss(c, row.id, 'personal'))
      expect(row).toMatchObject({
        status: 'dismissed',
        rejectReason: 'not applicable to this workspace',
      })
      expect(t.log.entries.at(-1)).toMatchObject({
        workspaceId: W,
        description:
          'Dismissed an emailed receipt from the receipts inbox: not applicable to this workspace',
        changes: [{ field: 'Status', before: 'unmatched', after: 'dismissed' }],
      })
      // Dealt with: it is not dismissed twice, nor run again.
      await expect(
        asRequest('u-owner', (c) => t.s.dismiss(c, row.id, 'duplicate'))
      ).rejects.toThrow(ConflictException)
      await expect(asRequest('u-owner', (c) => t.s.runAgain(c, row.id))).rejects.toThrow(
        ConflictException
      )
    })

    it('dismisses a failed receipt too, with its reason, but never a refused one', async () => {
      const t = ready()
      t.engagements[1]!.status = 'active'
      const row = await t.receive('Lunch receipt')
      row.status = 'failed'
      await asRequest('u-owner', (c) => t.s.dismiss(c, row.id, 'duplicate'))
      expect(row.status).toBe('dismissed')
      expect(t.log.entries.at(-1)).toMatchObject({
        changes: [{ field: 'Status', before: 'failed', after: 'dismissed' }],
      })
      const refused = await t.receive('Another receipt')
      refused.status = 'rejected'
      await expect(
        asRequest('u-owner', (c) => t.s.dismiss(c, refused.id, 'duplicate'))
      ).rejects.toThrow(ConflictException)
    })

    it('files an unmatched receipt where the person says, as that person', async () => {
      const t = ready()
      t.engagements[1]!.status = 'active'
      const row = await t.receive('Lunch receipt')
      expect(row.status).toBe('unmatched')
      await expect(
        asRequest('u-aud', (c) =>
          t.s.fileByHand(c, row.id, { engagementId: 'e-cp', period: '2026-08' })
        )
      ).rejects.toThrow(ForbiddenException)
      await expect(
        asRequest('u-owner', (c) =>
          t.s.fileByHand(c, row.id, { engagementId: 'e-cp', period: 'August' })
        )
      ).rejects.toThrow(/YYYY-MM/)
      const inbox = await asRequest('u-owner', (c) =>
        t.s.fileByHand(c, row.id, {
          engagementId: 'e-cp',
          period: '2026-08',
        })
      )
      expect(inbox.items[0]).toMatchObject({ status: 'filed', engagementId: 'e-cp' })
      expect(t.filed).toEqual([
        expect.objectContaining({
          reportId: 'r-2026-08',
          description: 'Filed a receipt for August 2026 of Coding Pathway from the receipts inbox',
        }),
      ])
      await expect(
        asRequest('u-owner', (c) =>
          t.s.fileByHand(c, row.id, { engagementId: 'e-cp', period: '2026-08' })
        )
      ).rejects.toThrow(ConflictException)
    })

    it('holds the receipt as "filing" while a person files it: the worker never claims it, and shows it working', async () => {
      const t = ready()
      t.engagements[1]!.status = 'active'
      const row = await t.receive('Lunch receipt')
      const during: { status: string; claimed: number; shown: string }[] = []
      const fileOne = t.receipts.fileOne.getMockImplementation()!
      t.receipts.fileOne.mockImplementationOnce(async (...args) => {
        const claimed = await t.s.runDue()
        const shown = (await asRequest('u-aud', (c) => t.s.inbox(c, W))).items[0]!.status
        during.push({ status: row.status, claimed, shown })
        return fileOne(...args)
      })
      await asRequest('u-owner', (c) =>
        t.s.fileByHand(c, row.id, { engagementId: 'e-cp', period: '2026-08' })
      )
      // Still "filing" (its lease renewed before the file), never claimed.
      expect(during).toEqual([{ status: 'filing', claimed: 0, shown: 'processing' }])
      expect(row.status).toBe('filed')
    })

    it('gives a hand filing that stopped part way back to the person once its lease runs out', async () => {
      const t = ready()
      t.engagements[1]!.status = 'active'
      const row = await t.receive('Lunch receipt')
      Object.assign(row, { status: 'filing', nextAttemptAt: new Date(0) })
      expect(await t.s.runDue()).toBe(0)
      expect(row.status).toBe('unmatched')
    })

    it('says why a month cannot take it, and leaves it to be filed', async () => {
      const t = ready()
      t.engagements[1]!.status = 'active'
      const row = await t.receive('Lunch receipt')
      t.months.push({
        id: 'r-2026-08',
        engagementId: 'e-cp',
        period: '2026-08',
        status: 'submitted',
        workspaceId: W,
      })
      await expect(
        asRequest('u-book', (c) =>
          t.s.fileByHand(c, row.id, { engagementId: 'e-cp', period: '2026-08' })
        )
      ).rejects.toThrow('August 2026 of Coding Pathway is submitted')
      expect(row.status).toBe('unmatched')
    })
  })
})
