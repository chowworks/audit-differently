import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import {
  PAYROLL_BUDGET_KINDS,
  PAYROLL_BUDGET_KIND_LABELS,
  WRITE_ROLES,
  lineKey,
  payrollHolder,
  payrollPlace,
  payrollRowKey,
  type PayrollBudgetKind,
  type PayrollRollupDto,
  type PayrollRollupEntry,
  type PayrollRollupInput,
  type PayrollRollupPreviewDto,
  type PayrollRollupSaved,
  type ReportLine,
} from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { allow, workspaceRole, type Caller } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'
import { BudgetService } from './budget.service'

const NOWHERE = 'Not linked to a Budget Line Item'

/**
 * The months a move of this kind puts back to draft (owner's decision, 2026-11-27): only those whose numbers change.
 * Participant pay counts on its line as each month is read, in that month and in every later month's spending to date,
 * so the locked months from the first with participant payments; staff pay and taxes, none (a locked month's rows and
 * the match's lines stay where they are). As `BudgetService.applyRollup` does it.
 */
function reopens(
  kind: PayrollBudgetKind,
  months: { period: string; status: string; _count: { wexPayments: number } }[]
): PayrollRollupPreviewDto['changes'][number]['backToDraft'] {
  if (kind !== 'participant-pay') return []
  const first = months.find((m) => m._count.wexPayments > 0)?.period
  return first
    ? months
        .filter((m) => m.period >= first && (m.status === 'closed' || m.status === 'submitted'))
        .map((m) => ({ period: m.period, was: m.status as 'closed' | 'submitted' }))
    : []
}

/**
 * Payroll budget line items (owner's decisions, 2026-11-27, #138): which budget line holds each kind of payroll from the
 * match, by the lines' names (several, no order), for the workspace, with an engagement's own entry. Kept on the
 * QuickBooks names table as the list 'payroll' (a row's name is the kind; Unallowable is "Not linked to a Budget Line Item"). An
 * engagement whose line would be unclear (two listed names, or none fits) has to be given its own entry before Save.
 * Saving a kind puts every
 * engagement's lines in step at once (`BudgetService.applyRollup`), so an engagement whose line changes has the closed and
 * submitted months whose numbers change put back to draft: the screen lists them first (`preview`). Owners and bookkeepers, as the
 * budget.
 */
@Injectable()
export class PayrollRollupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: BudgetService,
    private readonly log: AccessLogService
  ) {}

  private keeper(caller: Caller, workspaceId: string) {
    if (!caller.workspaceIds.includes(workspaceId)) throw new NotFoundException()
    allow(
      workspaceRole(caller, workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper says where payroll goes on the budget'
    )
  }

  private async read(workspaceId: string) {
    const [rows, engagements] = await Promise.all([
      this.prisma.lineAlias.findMany({
        where: { workspaceId, list: 'payroll' },
        orderBy: [{ name: 'asc' }, { engagementId: 'asc' }],
        select: { name: true, engagementId: true, budgetLineName: true, unallowable: true },
      }),
      this.prisma.engagement.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          budgetLines: {
            orderBy: { sortOrder: 'asc' },
            select: { id: true, name: true, reportLine: true, payroll: true },
          },
          monthlyReports: {
            orderBy: { period: 'asc' },
            select: { period: true, status: true, _count: { select: { wexPayments: true } } },
          },
        },
      }),
    ])
    const entries: PayrollRollupEntry[] = rows.flatMap((r) =>
      (PAYROLL_BUDGET_KINDS as readonly string[]).includes(r.name)
        ? [
            {
              kind: r.name as PayrollBudgetKind,
              engagementId: r.engagementId,
              budgetLineName: r.unallowable ? null : r.budgetLineName,
            },
          ]
        : []
    )
    return { entries, engagements }
  }

  private dtoOf(read: Awaited<ReturnType<PayrollRollupService['read']>>): PayrollRollupDto {
    return {
      entries: read.entries,
      engagements: read.engagements.map((e) => ({
        id: e.id,
        name: e.name,
        lines: e.budgetLines.map((b) => ({ name: b.name, reportLine: b.reportLine as ReportLine })),
      })),
    }
  }

  /** The list and each engagement's lines, for the workspace page. */
  async list(caller: Caller, workspaceId: string): Promise<PayrollRollupDto> {
    this.keeper(caller, workspaceId)
    return this.dtoOf(await this.read(workspaceId))
  }

  /** A kind and its entries, checked: every problem at once. */
  private clean(
    kind: string,
    given: unknown,
    engagements: { id: string; name: string; budgetLines: { name: string }[] }[]
  ): { kind: PayrollBudgetKind; input: PayrollRollupInput } {
    if (!(PAYROLL_BUDGET_KINDS as readonly string[]).includes(kind)) throw new NotFoundException()
    const g = (given && typeof given === 'object' ? given : {}) as Partial<PayrollRollupInput>
    const problems: string[] = []
    const lineOf = (name: unknown, on: typeof engagements) => {
      if (name === null) return null
      if (typeof name !== 'string' || !name.trim()) return undefined
      for (const e of on)
        for (const b of e.budgetLines) if (lineKey(b.name) === lineKey(name)) return b.name
      return undefined
    }
    let every: string[] | null = null
    if (g.every === undefined)
      problems.push('Choose the budget lines that hold it, or Not linked to a Budget Line Item')
    else if (g.every !== null) {
      every = []
      const keys = new Set<string>()
      for (const name of Array.isArray(g.every) ? g.every : [undefined]) {
        const line = lineOf(name, engagements)
        if (!line) problems.push(`No engagement has a budget line named ${String(name)}`)
        else if (!keys.has(lineKey(line))) {
          keys.add(lineKey(line))
          every.push(line)
        }
      }
    }
    const own: PayrollRollupInput['own'] = []
    const seen = new Set<string>()
    for (const o of Array.isArray(g.own) ? g.own : []) {
      const e = engagements.find((x) => x.id === o?.engagementId)
      if (!e || seen.has(e.id)) {
        problems.push('Choose engagements of this workspace, each once')
        continue
      }
      seen.add(e.id)
      const line = lineOf(o.budgetLineName ?? null, [e])
      if (line === undefined)
        problems.push(`${e.name} has no budget line named ${String(o.budgetLineName)}`)
      else own.push({ engagementId: e.id, budgetLineName: line })
    }
    if (problems.length) throw new BadRequestException(problems.join('. '))
    return { kind: kind as PayrollBudgetKind, input: { every, own } }
  }

  /** The kind's entries as `input` says, with every other kind's as they are. */
  private proposed(
    entries: PayrollRollupEntry[],
    kind: PayrollBudgetKind,
    input: PayrollRollupInput
  ) {
    return [
      ...entries.filter((e) => e.kind !== kind),
      ...(input.every === null
        ? [{ kind, engagementId: null, budgetLineName: null }]
        : input.every.map((n) => ({ kind, engagementId: null, budgetLineName: n }))),
      ...input.own.map((o) => ({ kind, ...o })),
    ]
  }

  /** Each engagement whose line for the kind would change, and its months that would go back to draft. */
  private changes(
    read: Awaited<ReturnType<PayrollRollupService['read']>>,
    kind: PayrollBudgetKind,
    input: PayrollRollupInput
  ): PayrollRollupPreviewDto['changes'] {
    const next = this.proposed(read.entries, kind, input)
    return read.engagements.flatMap((e) => {
      const from = e.budgetLines.find((b) => b.payroll.includes(kind))?.name ?? null
      const to = payrollHolder(kind, e.id, next, e.budgetLines)?.name ?? null
      if ((from && lineKey(from)) === (to && lineKey(to))) return []
      return [
        {
          engagementId: e.id,
          name: e.name,
          from,
          to,
          backToDraft: reopens(kind, e.monthlyReports),
        },
      ]
    })
  }

  /**
   * Each engagement with lines whose line this change would leave unclear: Save waits for a choice for each. One already
   * unclear is left to its own Choose and the month check, not asked about on every row edited.
   */
  private unclear(
    read: Awaited<ReturnType<PayrollRollupService['read']>>,
    kind: PayrollBudgetKind,
    input: PayrollRollupInput
  ): PayrollRollupPreviewDto['unclear'] {
    const next = this.proposed(read.entries, kind, input)
    return read.engagements.flatMap((e) => {
      if (!e.budgetLines.length) return []
      if (payrollPlace(kind, e.id, read.entries, e.budgetLines).by === 'unclear') return []
      const p = payrollPlace(kind, e.id, next, e.budgetLines)
      return p.by === 'unclear'
        ? [{ engagementId: e.id, name: e.name, choices: p.choices.map((l) => l.name) }]
        : []
    })
  }

  /** Before Save: the engagements whose line would change, and the months each would put back to draft. */
  async preview(
    caller: Caller,
    workspaceId: string,
    kind: string,
    given: unknown
  ): Promise<PayrollRollupPreviewDto> {
    this.keeper(caller, workspaceId)
    const read = await this.read(workspaceId)
    const c = this.clean(kind, given, read.engagements)
    return {
      changes: this.changes(read, c.kind, c.input),
      unclear: this.unclear(read, c.kind, c.input),
    }
  }

  /**
   * A kind's entries saved as a whole, and every engagement's lines put in step in the same transaction: one whose line
   * changes has its closed and submitted months put back to draft and its books' payroll rows of the kind moved, then
   * every month of it checked again.
   */
  async save(
    caller: Caller,
    workspaceId: string,
    kind: string,
    given: unknown
  ): Promise<PayrollRollupSaved> {
    this.keeper(caller, workspaceId)
    const read = await this.read(workspaceId)
    const { kind: k, input } = this.clean(kind, given, read.engagements)
    const unclear = this.unclear(read, k, input)
    if (unclear.length)
      throw new BadRequestException(
        unclear
          .map(
            (u) =>
              `Choose which line holds ${PAYROLL_BUDGET_KIND_LABELS[k].toLowerCase()} on ${u.name}`
          )
          .join('. ')
      )
    const changed = this.changes(read, k, input)
    const label = PAYROLL_BUDGET_KIND_LABELS[k]
    const names = new Map(read.engagements.map((e) => [e.id, e.name]))
    const backToDraft: PayrollRollupSaved['backToDraft'] = []
    const touched: string[] = []
    let moved = 0
    await this.log.change(
      caller,
      async (tx) => {
        await tx.lineAlias.deleteMany({ where: { workspaceId, list: 'payroll', name: k } })
        const row = (engagementId: string | null, budgetLineName: string | null) => ({
          workspaceId,
          engagementId,
          list: 'payroll',
          name: k,
          key: payrollRowKey(k, engagementId ? null : budgetLineName),
          budgetLineName,
          unallowable: budgetLineName === null,
          changedById: caller.userId,
        })
        await tx.lineAlias.createMany({
          data: [
            ...(input.every === null ? [row(null, null)] : input.every.map((n) => row(null, n))),
            ...input.own.map((o) => row(o.engagementId, o.budgetLineName)),
          ],
        })
        for (const e of read.engagements) {
          const r = await this.budget.applyRollup(tx, caller, { ...e, workspaceId }, true)
          if (!r.changed) continue
          touched.push(e.id)
          moved += r.rows.moved
          for (const m of r.backed)
            backToDraft.push({ engagementName: e.name, period: m.period, was: m.was })
        }
      },
      () => ({
        workspaceId,
        resource: 'workspace',
        subjectId: workspaceId,
        action: 'update',
        description: `Changed where ${label} goes on the budget`,
        changes: [
          {
            field: `${label}: every engagement`,
            after:
              input.every === null
                ? NOWHERE
                : input.every.join(', ') || 'The line of its report line',
          },
          ...input.own.map((o) => ({
            field: `${label}: ${names.get(o.engagementId)}`,
            after: o.budgetLineName ?? NOWHERE,
          })),
          ...(changed.length
            ? [{ field: 'Engagements whose line changed', after: String(changed.length) }]
            : []),
          ...(moved ? [{ field: 'Imported payroll rows moved', after: String(moved) }] : []),
        ],
      }),
      { timeout: 30_000 }
    )
    for (const id of touched) await this.budget.recheck(id)
    return { ...this.dtoOf(await this.read(workspaceId)), backToDraft }
  }
}
