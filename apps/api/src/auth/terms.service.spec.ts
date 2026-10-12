import { TermsService } from './terms.service'

/** A TermsAcceptance table in memory: findUnique by (userId, fingerprint), createMany with skipDuplicates. */
function fakePrisma() {
  const rows = new Set<string>()
  const termsAcceptance = {
    findUnique: jest.fn(
      async ({
        where,
      }: {
        where: { userId_fingerprint: { userId: string; fingerprint: string } }
      }) =>
        rows.has(`${where.userId_fingerprint.userId}|${where.userId_fingerprint.fingerprint}`)
          ? { id: 'x' }
          : null
    ),
    count: jest.fn(
      async ({ where }: { where: { userId: string; fingerprint: { not: string } } }) =>
        [...rows].filter((r) => {
          const [u, v] = r.split('|')
          return u === where.userId && v !== where.fingerprint.not
        }).length
    ),
    createMany: jest.fn(
      async ({
        data,
      }: {
        data: { userId: string; fingerprint: string }[]
        skipDuplicates: boolean
      }) => {
        for (const d of data) rows.add(`${d.userId}|${d.fingerprint}`)
      }
    ),
  }
  return { prisma: { termsAcceptance } as never, termsAcceptance, rows }
}

describe('TermsService', () => {
  it('says no until the person accepts, then yes', async () => {
    const { prisma } = fakePrisma()
    const s = new TermsService(prisma, 'v1')
    expect(await s.hasAccepted('u1')).toBe(false)
    await s.accept('u1')
    expect(await s.hasAccepted('u1')).toBe(true)
    expect(await s.hasAccepted('u2')).toBe(false)
  })

  it('accepting twice is one row and no error', async () => {
    const { prisma, rows, termsAcceptance } = fakePrisma()
    const s = new TermsService(prisma, 'v1')
    await s.accept('u1')
    await s.accept('u1')
    expect(rows.size).toBe(1)
    expect(termsAcceptance.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    )
  })

  it('asks again when the version changes', async () => {
    const { prisma, rows } = fakePrisma()
    await new TermsService(prisma, 'v1').accept('u1')
    const next = new TermsService(prisma, 'v2')
    expect(await next.hasAccepted('u1')).toBe(false)
    await next.accept('u1')
    expect(await next.hasAccepted('u1')).toBe(true)
    expect(rows).toEqual(new Set(['u1|v1', 'u1|v2']))
  })

  it('remembers a yes, so the database is asked once', async () => {
    const { prisma, termsAcceptance } = fakePrisma()
    const s = new TermsService(prisma, 'v1')
    await s.accept('u1')
    await s.hasAccepted('u1')
    await s.hasAccepted('u1')
    expect(termsAcceptance.findUnique).not.toHaveBeenCalled()
    const other = new TermsService(prisma, 'v1') // another instance has no memory yet
    await other.hasAccepted('u1')
    await other.hasAccepted('u1')
    expect(termsAcceptance.findUnique).toHaveBeenCalledTimes(1)
  })

  it('never remembers a no', async () => {
    const { prisma, termsAcceptance, rows } = fakePrisma()
    const s = new TermsService(prisma, 'v1')
    expect(await s.hasAccepted('u1')).toBe(false)
    expect(await s.hasAccepted('u1')).toBe(false)
    expect(termsAcceptance.findUnique).toHaveBeenCalledTimes(2)
    rows.add('u1|v1') // accepted elsewhere (another instance)
    expect(await s.hasAccepted('u1')).toBe(true)
  })

  it('knows a returning person: an older version accepted, not the current one', async () => {
    const { prisma } = fakePrisma()
    expect(await new TermsService(prisma, 'v1').hasAcceptedBefore('u1')).toBe(false) // new user
    await new TermsService(prisma, 'v1').accept('u1')
    expect(await new TermsService(prisma, 'v1').hasAcceptedBefore('u1')).toBe(false) // only the current
    const next = new TermsService(prisma, 'v2')
    expect(await next.hasAcceptedBefore('u1')).toBe(true)
    expect(await next.hasAcceptedBefore('u2')).toBe(false)
  })
})
