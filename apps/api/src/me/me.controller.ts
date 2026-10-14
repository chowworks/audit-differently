import { Throttle } from '@nestjs/throttler'
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { AcceptTermsRequest, Me, Role } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { ClerkService } from '../auth/clerk.service'
import { SkipTermsGate } from '../auth/skip-terms-gate.decorator'
import { TermsService } from '../auth/terms.service'
import { AccessLogService } from '../core/access-log.service'
import { changesOf } from '../core/changes'
import { runAsSystem } from '../core/tenant-context'
import { PrismaService } from '../prisma/prisma.service'
import { ROLE_FIELDS, roleWord } from '../workspaces/workspaces.service'

@Controller('me')
@UseGuards(AuthenticatedGuard)
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
    private readonly terms: TermsService,
    private readonly log: AccessLogService
  ) {}

  /**
   * The caller and every workspace they belong to. Creates the User row on first sight and, while the person
   * belongs to nothing yet, keeps looking for an invitation's placeholder under their email: the row may have
   * been made before the email was known, or the invitation may come later. Open to a person who has not accepted
   * the Terms yet: it says so (`termsAccepted`), and is how the app finds out.
   */
  @SkipTermsGate()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get()
  async me(@Req() req: { userId: string }): Promise<Me> {
    const existing = await this.prisma.user.findUnique({
      where: { id: req.userId },
      include: { memberships: { select: { id: true } } },
    })
    if (!existing || existing.memberships.length === 0) {
      const profile = await this.clerk.profile(req.userId)
      const email = profile.email ?? existing?.email ?? null
      // An invitation made a placeholder row under this email; the real account takes its memberships. The claim
      // and a "Joined" line for each workspace are one transaction: both are kept, or neither (and the placeholder
      // stays for the next sign-in). The lines are written as the person, now a member (AccessLogService.trusted).
      await runAsSystem(() =>
        this.log.trusted(
          { userId: req.userId, email },
          async (tx) => {
            const pending = profile.email
              ? await tx.user.findFirst({
                  where: {
                    id: { startsWith: 'pending-' },
                    email: { equals: profile.email, mode: 'insensitive' },
                  },
                  include: { memberships: { include: { workspace: { select: { name: true } } } } },
                })
              : null
            // The placeholder goes first: its email is unique, and this account takes it over.
            const seats = pending?.memberships ?? []
            if (pending) await tx.user.delete({ where: { id: pending.id } })
            if (existing)
              await tx.user.update({
                where: { id: req.userId },
                data: {
                  email,
                  displayName: profile.displayName ?? pending?.displayName ?? existing.displayName,
                },
              })
            else
              await tx.user.create({
                data: {
                  id: req.userId,
                  email,
                  displayName: profile.displayName ?? pending?.displayName ?? null,
                },
              })
            const joined = []
            for (const m of seats) {
              const seat = await tx.membership.create({
                data: { userId: req.userId, workspaceId: m.workspaceId, role: m.role },
              })
              joined.push({ seat, workspaceName: m.workspace.name })
            }
            return joined
          },
          (joined) =>
            joined.map(({ seat, workspaceName }) => ({
              workspaceId: seat.workspaceId,
              resource: 'member' as const,
              subjectId: req.userId,
              action: 'create' as const,
              description: `Joined ${workspaceName} as ${roleWord(seat.role)}`,
              changes: changesOf(null, { role: seat.role }, ROLE_FIELDS),
            }))
        )
      )
    }
    const memberships = await this.prisma.membership.findMany({
      where: { userId: req.userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    })
    const termsAccepted = await this.terms.hasAccepted(req.userId)
    return {
      userId: req.userId,
      termsVersion: this.terms.version,
      termsAccepted,
      termsPreviouslyAccepted: !termsAccepted && (await this.terms.hasAcceptedBefore(req.userId)),
      memberships: memberships.map((m) => ({
        workspaceId: m.workspaceId,
        workspaceName: m.workspace.name,
        role: m.role as Role,
      })),
    }
  }

  /** The caller accepts the current Terms. Accepting again changes nothing; any other version is refused. */
  @SkipTermsGate()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(204)
  @Post('terms')
  async acceptTerms(
    @Req() req: { userId: string },
    @Body() body: Partial<AcceptTermsRequest>
  ): Promise<void> {
    if (body?.version !== this.terms.version)
      throw new BadRequestException(
        `Those are not the current Terms (${this.terms.version}); reload the page and read them again.`
      )
    await this.terms.accept(req.userId)
  }
}
