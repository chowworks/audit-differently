import { BadRequestException, Injectable } from '@nestjs/common'
import {
  DEFAULT_HIGHLIGHTS,
  HIGHLIGHT_FIELDS,
  PAYROLL_DOCUMENT_KINDS,
  type HighlightField,
  type HighlightSettingDto,
  type PayrollDocumentKind,
} from '@ad/types'
import type { Caller } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'

/**
 * What is highlighted on each payroll proof type, for the whole system (owner's decision, 2026-10-16): set by a
 * platform admin in Admin tools → Highlights, read by every match. Append-only (migration 20261016001400): each save
 * is a new row, the newest per kind is in force, and a kind never set uses DEFAULT_HIGHLIGHTS. The rows are their own
 * history: who changed what, and when.
 */
@Injectable()
export class HighlightSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every proof type with its fields in force and who set them last. */
  async list(): Promise<HighlightSettingDto[]> {
    const rows = await this.prisma.highlightSetting.findMany({ orderBy: { changedAt: 'desc' } })
    return PAYROLL_DOCUMENT_KINDS.map((kind) => {
      const row = rows.find((r) => r.kind === kind)
      return {
        kind,
        fields: row ? (row.fields as HighlightField[]) : [...DEFAULT_HIGHLIGHTS[kind]],
        changedByEmail: row?.changedByEmail ?? null,
        changedAt: row?.changedAt.toISOString() ?? null,
      }
    })
  }

  /** The fields in force, by proof type, for matching. */
  async current(): Promise<Record<PayrollDocumentKind, HighlightField[]>> {
    const list = await this.list()
    return Object.fromEntries(list.map((s) => [s.kind, s.fields])) as Record<
      PayrollDocumentKind,
      HighlightField[]
    >
  }

  /** A platform admin sets one proof type's fields: at least one, from the list, in the order given. */
  async set(admin: Caller, kind: string, fields: unknown): Promise<HighlightSettingDto[]> {
    if (!(PAYROLL_DOCUMENT_KINDS as readonly string[]).includes(kind))
      throw new BadRequestException(
        'Choose a timesheet, payroll register, pay stub, bank statement or payroll details'
      )
    const list = Array.isArray(fields) ? [...new Set(fields)] : []
    if (!list.length || !list.every((f) => (HIGHLIGHT_FIELDS as readonly unknown[]).includes(f)))
      throw new BadRequestException('Choose at least one thing to highlight, from the list')
    await this.prisma.highlightSetting.create({
      data: {
        kind,
        fields: list as string[],
        changedById: admin.userId,
        changedByEmail: admin.email,
      },
    })
    return this.list()
  }
}
