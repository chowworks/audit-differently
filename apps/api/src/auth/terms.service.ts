import { Inject, Injectable, Optional } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { currentTermsVersion } from './terms-fingerprint'

/** Injection token for the version everyone must have accepted; only a spec provides it, to test a change of wording. */
export const CURRENT_TERMS_VERSION = 'CURRENT_TERMS_VERSION'

/**
 * Who has accepted the current Terms. The current version is the fingerprint of their wording, read once when
 * the API starts (terms-fingerprint.ts). A TermsAcceptance row is one person accepting one version; it is only ever
 * added. A yes is remembered in memory (acceptance cannot be taken back), a no never is, so the next request asks
 * the database again and sees an acceptance made a moment ago, from this instance or another.
 */
@Injectable()
export class TermsService {
  private readonly accepted = new Set<string>()

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(CURRENT_TERMS_VERSION) readonly version: string = currentTermsVersion()
  ) {}

  async hasAccepted(userId: string): Promise<boolean> {
    const key = `${userId}\n${this.version}`
    if (this.accepted.has(key)) return true
    const row = await this.prisma.termsAcceptance.findUnique({
      where: { userId_fingerprint: { userId, fingerprint: this.version } },
      select: { id: true },
    })
    if (row) this.accepted.add(key)
    return !!row
  }

  /** Whether the person accepted some older version (so the app words the prompt as an update, not a first time). */
  async hasAcceptedBefore(userId: string): Promise<boolean> {
    return (
      (await this.prisma.termsAcceptance.count({
        where: { userId, fingerprint: { not: this.version } },
      })) > 0
    )
  }

  /** Records the acceptance of the current version; accepting again changes nothing. */
  async accept(userId: string): Promise<void> {
    await this.prisma.termsAcceptance.createMany({
      data: [{ userId, fingerprint: this.version }],
      skipDuplicates: true,
    })
    this.accepted.add(`${userId}\n${this.version}`)
  }
}
