import 'reflect-metadata'
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { APP_GUARD } from '@nestjs/core'
import helmet from 'helmet'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'
import { LocalDiskStorage } from '../storage/local-disk-storage'
import { DocumentsController } from './documents.controller'
import { DocumentsService, MAX_UPLOAD_BYTES } from './documents.service'

@Injectable()
class FakeGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest()
    if (!String(req.headers.authorization ?? '').startsWith('Bearer '))
      throw new UnauthorizedException()
    req.userId = 'u1'
    return true
  }
}

/**
 * The upload route end to end over HTTP, on the real controller and interceptor with the service mocked:
 * multipart parsing, the size limit, the sign-in gate, the rate limit and the security headers. No database.
 */
describe('POST /api/documents', () => {
  let app: INestApplication
  let base: string
  const upload = jest.fn(
    async (
      _c: unknown,
      file: { originalname: string; size: number; buffer: Buffer; mimetype: string },
      body: object
    ) => ({
      id: 'd1',
      name: file.originalname,
      size: file.size,
      bytes: file.buffer.length,
      mime: file.mimetype,
      body,
    })
  )

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }])],
      controllers: [DocumentsController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: DocumentsService, useValue: { upload } },
        { provide: CallerService, useValue: { load: async () => ({ userId: 'u1' }) } },
        { provide: PrismaService, useValue: {} },
        { provide: LocalDiskStorage, useValue: {} },
      ],
    })
      .overrideGuard(AuthenticatedGuard)
      .useClass(FakeGuard)
      .compile()
    app = mod.createNestApplication()
    app.setGlobalPrefix('api')
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
        },
      })
    )
    await app.listen(0)
    base = (await app.getUrl()).replace('[::1]', 'localhost')
  })
  afterAll(async () => app.close())

  const form = (bytes: number, field = 'file', extra: Record<string, string> = {}) => {
    const f = new FormData()
    f.append('workspaceId', 'w1')
    f.append('kind', 'invoice')
    for (const [k, v] of Object.entries(extra)) f.append(k, v)
    f.append(field, new Blob([Buffer.alloc(bytes, 65)], { type: 'application/pdf' }), 'a.pdf')
    return f
  }
  const post = (f: FormData, auth = true) =>
    fetch(`${base}/api/documents`, {
      method: 'POST',
      body: f,
      headers: auth ? { authorization: 'Bearer x' } : {},
    })

  it('accepts a multipart upload: file bytes and body fields reach the service', async () => {
    const r = await post(form(1000, 'file', { period: '2026-09', engagementId: 'e1' }))
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j).toMatchObject({
      name: 'a.pdf',
      size: 1000,
      bytes: 1000,
      mime: 'application/pdf',
      body: { workspaceId: 'w1', kind: 'invoice', period: '2026-09', engagementId: 'e1' },
    })
  })
  it('refuses a file over the limit with 413 and never calls the service', async () => {
    upload.mockClear()
    const r = await post(form(MAX_UPLOAD_BYTES + 10))
    expect(r.status).toBe(413)
    expect(upload).not.toHaveBeenCalled()
  })
  it('accepts exactly the limit', async () => {
    const r = await post(form(MAX_UPLOAD_BYTES))
    expect(r.status).toBe(201)
  })
  it('refuses a wrong field name (no file) without a 500', async () => {
    const r = await post(form(10, 'other'))
    expect([400, 404]).toContain(r.status)
  })
  it('refuses a second file part', async () => {
    const f = form(10)
    f.append('file', new Blob(['x']), 'b.pdf')
    const r = await post(f)
    expect(r.status).toBeLessThan(500)
    expect(r.status).toBeGreaterThanOrEqual(400)
  })
  it('refuses without a token', async () => {
    expect((await post(form(10), false)).status).toBe(401)
  })
  it('sends the security headers', async () => {
    const r = await post(form(10))
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'")
  })
  it('throttles uploads at 20 per minute with 429', async () => {
    const codes: number[] = []
    for (let i = 0; i < 25; i++) codes.push((await post(form(10))).status)
    expect(codes).toContain(429)
  })
})
