import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import {
  MAX_LINE_ALIASES,
  WRITE_ROLES,
  aliasKey,
  type LineAliasDto,
  type LineAliasGroupInput,
  type LineAliasInput,
  type LineAliasesDto,
  type LineAliasesMergeDto,
} from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { allow, workspaceRole, type Caller } from '../core/caller'
import { howMany } from '../core/changes'
import { PrismaService } from '../prisma/prisma.service'
import { accountMappingOf, engagementOfMapping } from '../expenses/account-mapping'
import { readGrid } from '../imports/table'
import { namesFileOf, type NamesFileRow } from './names-file'
import { mappingNames } from './mapping-names'
import { writeFor, type AliasChoice, type AliasRow, type AliasWrite } from './resolve'

/** A mapping file's rows are a chart of accounts: a few hundred at most. */
const MAX_ACCOUNTS = 2000

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/** The row as the screens get it. */
export const aliasDto = (a: AliasRow): LineAliasDto => ({
  id: a.id,
  name: a.name,
  engagementId: a.engagementId,
  budgetLineName: a.budgetLineName,
  unallowable: a.unallowable,
})

/**
 * The QuickBooks names list (owner's decision, 2026-11-27, #132): which budget line each QuickBooks account or category
 * goes to, for Import transactions and Month End Close alike. Owners and bookkeepers keep it on the workspace page, a
 * choice made on either screen adds to it, and the account mapping folder's files fill it.
 */
@Injectable()
export class AliasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService
  ) {}

  /** The caller keeps the list: an owner or bookkeeper of the workspace (another workspace's is a 404). */
  private keeper(caller: Caller, workspaceId: string) {
    if (!caller.workspaceIds.includes(workspaceId)) throw new NotFoundException()
    allow(
      workspaceRole(caller, workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper keeps the QuickBooks names'
    )
  }

  /** Every row of the workspace's list, overrides included (the lookup's input). */
  rows(workspaceId: string, db: Prisma.TransactionClient = this.prisma): Promise<AliasRow[]> {
    return db.lineAlias.findMany({
      where: { workspaceId, list: 'quickbooks' },
      orderBy: [{ name: 'asc' }, { engagementId: 'asc' }],
      select: { id: true, engagementId: true, name: true, budgetLineName: true, unallowable: true },
    })
  }

  private engagements(workspaceId: string) {
    return this.prisma.engagement.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        number: true,
        code: true,
        periodStart: true,
        periodEnd: true,
        awardAmount: true,
        budgetLines: { orderBy: { sortOrder: 'asc' }, select: { name: true, amount: true } },
      },
    })
  }

  private async dto(workspaceId: string): Promise<LineAliasesDto> {
    const [aliases, engagements] = await Promise.all([
      this.rows(workspaceId),
      this.engagements(workspaceId),
    ])
    return {
      aliases: aliases.map(aliasDto),
      engagements: engagements.map((e) => ({
        id: e.id,
        name: e.name,
        budgetLines: e.budgetLines.map((b) => b.name),
      })),
    }
  }

  /** The list and each engagement's budget line names, for the workspace page. */
  async list(caller: Caller, workspaceId: string): Promise<LineAliasesDto> {
    this.keeper(caller, workspaceId)
    return this.dto(workspaceId)
  }

  /**
   * A name and where it goes, checked: a name, an engagement of the workspace (an override) or none (the workspace's
   * own), and a budget line's name that is a line of that engagement (of any engagement, for the workspace's), or
   * Unallowable. Every problem at once.
   */
  private async clean(
    workspaceId: string,
    given: unknown,
    partial?: AliasRow
  ): Promise<AliasWrite> {
    const g = (given && typeof given === 'object' ? given : {}) as LineAliasInput
    const problems: string[] = []
    const name = typeof g.name === 'string' ? g.name.trim() : (partial?.name ?? '')
    if (!name) problems.push('Give the QuickBooks name')
    else if (!aliasKey(name)) problems.push('Give a QuickBooks name with letters or numbers')
    else if (name.length > 200) problems.push('Keep the QuickBooks name under 200 characters')
    const engagementId =
      g.engagementId === undefined ? (partial?.engagementId ?? null) : g.engagementId || null
    const unallowable =
      g.unallowable === undefined ? (partial?.unallowable ?? false) : g.unallowable === true
    const lineName = unallowable
      ? null
      : typeof g.budgetLineName === 'string'
        ? g.budgetLineName.trim()
        : (partial?.budgetLineName ?? null)
    const engagements = await this.engagements(workspaceId)
    if (engagementId !== null && typeof engagementId !== 'string')
      problems.push('Choose an engagement')
    const e = engagementId ? engagements.find((x) => x.id === engagementId) : null
    if (engagementId && !e) problems.push('That engagement is not in this workspace')
    if (!unallowable) {
      const names = (e ? [e] : engagements).flatMap((x) =>
        x.budgetLines.map((b) => aliasKey(b.name))
      )
      if (!lineName) problems.push('Choose a budget line, or Unallowable')
      else if (!names.includes(aliasKey(lineName)))
        problems.push(
          e
            ? `${e.name} has no budget line named ${lineName}`
            : `No engagement has a budget line named ${lineName}`
        )
    }
    if (problems.length) throw new BadRequestException(problems.join('. '))
    return { name, engagementId, budgetLineName: unallowable ? null : lineName, unallowable }
  }

  /** Writes one row: a new name, or the name's row on that engagement (or the workspace) changed. */
  private async put(
    tx: Prisma.TransactionClient,
    caller: Caller,
    workspaceId: string,
    w: AliasWrite,
    id?: string
  ) {
    const data = {
      name: w.name,
      key: aliasKey(w.name),
      engagementId: w.engagementId,
      budgetLineName: w.budgetLineName,
      unallowable: w.unallowable,
      changedById: caller.userId,
      changedAt: new Date(),
    }
    const same = await tx.lineAlias.findFirst({
      where: { workspaceId, list: 'quickbooks', engagementId: w.engagementId, key: data.key },
      select: { id: true },
    })
    if (id && same && same.id !== id)
      throw new ConflictException('That name is on the list already: change that entry instead')
    const target = id ?? same?.id
    if (target) return tx.lineAlias.update({ where: { id: target }, data })
    if ((await tx.lineAlias.count({ where: { workspaceId } })) >= MAX_LINE_ALIASES)
      throw new BadRequestException(`The list keeps at most ${MAX_LINE_ALIASES} names`)
    return tx.lineAlias.create({ data: { ...data, workspaceId, list: 'quickbooks' } })
  }

  private where(w: AliasWrite, names: Map<string, string>) {
    return w.engagementId
      ? `for ${names.get(w.engagementId) ?? 'one engagement'}`
      : 'for every engagement'
  }

  /** A name added on the workspace page (a workspace entry or an engagement's override). */
  async create(caller: Caller, workspaceId: string, given: unknown): Promise<LineAliasesDto> {
    this.keeper(caller, workspaceId)
    const w = await this.clean(workspaceId, given)
    const names = new Map((await this.engagements(workspaceId)).map((e) => [e.id, e.name]))
    await this.log.change(caller, (tx) => this.put(tx, caller, workspaceId, w), {
      workspaceId,
      resource: 'workspace',
      subjectId: workspaceId,
      action: 'create',
      description: `Added a QuickBooks name to the list ${this.where(w, names)}`,
      changes: [{ field: 'Goes to', after: w.unallowable ? 'Unallowable' : w.budgetLineName! }],
    })
    return this.dto(workspaceId)
  }

  /** A name or where it goes, changed on the workspace page. */
  async update(
    caller: Caller,
    workspaceId: string,
    aliasId: string,
    given: unknown
  ): Promise<LineAliasesDto> {
    this.keeper(caller, workspaceId)
    const row = await this.prisma.lineAlias.findFirst({ where: { id: aliasId, workspaceId } })
    if (!row) throw new NotFoundException()
    const w = await this.clean(workspaceId, given, row)
    const names = new Map((await this.engagements(workspaceId)).map((e) => [e.id, e.name]))
    const goes = (a: { unallowable: boolean; budgetLineName: string | null }) =>
      a.unallowable ? 'Unallowable' : a.budgetLineName!
    // A workspace entry renamed takes its engagements' overrides of the old name with it (decision 6): the dialog
    // listed them before Save. One already there under the new name stays as it is.
    const renamed = row.engagementId === null && row.key !== aliasKey(w.name)
    const write = async (tx: Prisma.TransactionClient) => {
      await this.put(tx, caller, workspaceId, w, row.id)
      if (!renamed) return
      const overrides = await tx.lineAlias.findMany({
        where: { workspaceId, list: row.list, key: row.key, NOT: { engagementId: null } },
      })
      for (const o of overrides) {
        const taken = await tx.lineAlias.findFirst({
          where: {
            workspaceId,
            list: row.list,
            engagementId: o.engagementId,
            key: aliasKey(w.name),
          },
          select: { id: true },
        })
        if (!taken)
          await tx.lineAlias.update({
            where: { id: o.id },
            data: {
              name: w.name,
              key: aliasKey(w.name),
              changedById: caller.userId,
              changedAt: new Date(),
            },
          })
      }
    }
    await this.log.change(caller, write, {
      workspaceId,
      resource: 'workspace',
      subjectId: workspaceId,
      action: 'update',
      description: `Changed a QuickBooks name on the list ${this.where(w, names)}`,
      changes: [
        ...(row.key !== aliasKey(w.name)
          ? [{ field: 'Name', before: '(changed)', after: '(changed)' }]
          : []),
        ...(goes(row) !== goes(w) ? [{ field: 'Goes to', before: goes(row), after: goes(w) }] : []),
      ],
    })
    return this.dto(workspaceId)
  }

  async remove(caller: Caller, workspaceId: string, aliasId: string): Promise<LineAliasesDto> {
    this.keeper(caller, workspaceId)
    const row = await this.prisma.lineAlias.findFirst({ where: { id: aliasId, workspaceId } })
    if (!row) throw new NotFoundException()
    const names = new Map((await this.engagements(workspaceId)).map((e) => [e.id, e.name]))
    await this.log.change(caller, (tx) => tx.lineAlias.delete({ where: { id: row.id } }), {
      workspaceId,
      resource: 'workspace',
      subjectId: workspaceId,
      action: 'delete',
      description: `Removed a QuickBooks name from the list ${this.where(row, names)}`,
    })
    return this.dto(workspaceId)
  }

  /**
   * A row of the workspace page saved as a whole (#132 tour, 2026-11-27): its name and where it maps to, for every
   * engagement or the ones ticked. Its entries for engagements no longer ticked go, each ticked one is written (an entry
   * that engagement already had for the name is changed), all in one transaction. A workspace entry kept for every
   * engagement is a plain change, so a rename still takes its engagements' entries with it.
   */
  async saveGroup(caller: Caller, workspaceId: string, given: unknown): Promise<LineAliasesDto> {
    this.keeper(caller, workspaceId)
    const g = (given && typeof given === 'object' ? given : {}) as Partial<LineAliasGroupInput>
    const ids = Array.isArray(g.ids) ? g.ids.filter((x): x is string => typeof x === 'string') : []
    const rows = ids.length
      ? await this.prisma.lineAlias.findMany({ where: { id: { in: ids }, workspaceId } })
      : []
    if (rows.length !== ids.length) throw new NotFoundException()
    const targets =
      g.engagementIds === null
        ? [null]
        : Array.isArray(g.engagementIds)
          ? [...new Set(g.engagementIds.filter((x): x is string => typeof x === 'string'))]
          : undefined
    if (!targets)
      throw new BadRequestException('Choose every engagement, or the engagements it applies to')
    if (
      targets.length === 1 &&
      targets[0] === null &&
      rows.length === 1 &&
      rows[0]!.engagementId === null
    )
      return this.update(caller, workspaceId, rows[0]!.id, { ...g, engagementId: null })
    const names = new Map((await this.engagements(workspaceId)).map((e) => [e.id, e.name]))
    const problems = new Set<string>()
    const writes: AliasWrite[] = []
    for (const engagementId of targets)
      try {
        writes.push(await this.clean(workspaceId, { ...g, engagementId }))
      } catch (e) {
        if (!(e instanceof BadRequestException)) throw e
        for (const p of String(e.message).split('. ')) problems.add(p)
      }
    if (problems.size) throw new BadRequestException([...problems].join('. '))
    const kept = new Set(targets)
    const goes = writes[0]
      ? writes[0].unallowable
        ? 'Unallowable'
        : writes[0].budgetLineName!
      : ''
    await this.log.change(
      caller,
      async (tx) => {
        for (const r of rows)
          if (!kept.has(r.engagementId)) await tx.lineAlias.delete({ where: { id: r.id } })
        for (const w of writes) {
          const own = rows.find((r) => r.engagementId === w.engagementId)
          await this.put(tx, caller, workspaceId, w, own?.id)
        }
      },
      {
        workspaceId,
        resource: 'workspace',
        subjectId: workspaceId,
        action: writes.length ? (rows.length ? 'update' : 'create') : 'delete',
        description: writes.length
          ? `Saved a financial category on the list for ${
              targets[0] === null
                ? 'every engagement'
                : targets.map((id) => names.get(id!) ?? 'one engagement').join(', ')
            }`
          : 'Removed a financial category from the list',
        changes: writes.length ? [{ field: 'Maps to', after: goes }] : [],
      }
    )
    return this.dto(workspaceId)
  }

  /**
   * Choices made on Import transactions or Month End Close, kept on the list as `writeFor` says (a new name the
   * workspace's, a different one or Unallowable that engagement's alone), in the caller's transaction when given.
   * Returns how many rows it wrote.
   */
  async learn(
    tx: Prisma.TransactionClient,
    caller: Caller,
    workspaceId: string,
    choices: AliasChoice[]
  ): Promise<number> {
    const rows = await this.rows(workspaceId, tx)
    let n = 0
    for (const c of choices) {
      // A name with nothing to compare is never kept; a full list keeps no more, and never stops an import.
      if (!aliasKey(c.name)) continue
      const w = writeFor(c, rows)
      if (!w) continue
      if (rows.length >= MAX_LINE_ALIASES && !this.has(rows, w)) continue
      this.keep(rows, await this.put(tx, caller, workspaceId, w))
      n++
    }
    return n
  }

  private has(rows: AliasRow[], w: AliasWrite) {
    return rows.some(
      (r) => r.engagementId === w.engagementId && aliasKey(r.name) === aliasKey(w.name)
    )
  }

  /** The list as written so far, kept in memory so a long merge reads it once. */
  private keep(rows: AliasRow[], row: AliasRow) {
    const at = rows.findIndex((r) => r.id === row.id)
    const kept = {
      id: row.id,
      engagementId: row.engagementId,
      name: row.name,
      budgetLineName: row.budgetLineName,
      unallowable: row.unallowable,
    }
    if (at >= 0) rows[at] = kept
    else rows.push(kept)
  }

  /** A choice made on Month End Close's expenses: one name on one engagement. */
  async choose(caller: Caller, workspaceId: string, given: unknown): Promise<LineAliasesDto> {
    this.keeper(caller, workspaceId)
    const g = (given && typeof given === 'object' ? given : {}) as LineAliasInput
    if (!g.engagementId) throw new BadRequestException('Choose the engagement')
    const w = await this.clean(workspaceId, { ...g, engagementId: g.engagementId })
    const choice: AliasChoice = {
      name: w.name,
      engagementId: g.engagementId,
      budgetLineName: w.budgetLineName,
    }
    // The list says it already: nothing to write, and no line.
    if (!writeFor(choice, await this.rows(workspaceId))) return this.dto(workspaceId)
    await this.log.change(
      caller,
      (tx) => this.learn(tx, caller, workspaceId, [choice]),
      (n) => ({
        workspaceId,
        resource: 'workspace',
        subjectId: workspaceId,
        action: 'update',
        description: `Chose where a QuickBooks name goes on Month End Close (${howMany(n, 'entry', 'entries')} on the list)`,
        changes: [{ field: 'Goes to', after: w.unallowable ? 'Unallowable' : w.budgetLineName! }],
      })
    )
    return this.dto(workspaceId)
  }

  /**
   * A file of the payroll zip's "Account mapping" folder (one engagement's chart of accounts and the category each bills
   * to) merged into the list, read in memory and never kept. Each account becomes a name as QuickBooks writes it
   * ("60901 Rent Expense") going to its category's budget line (the line the file's side box names, else the line of
   * the box's amount, else the line named as the category). When the file says whose engagement it is, an account it
   * leaves blank is Unallowable there, and an account it sends elsewhere than the list does is that engagement's
   * override; when it does not say, blank accounts are left out.
   */
  async merge(
    caller: Caller,
    workspaceId: string,
    file: { buffer: Buffer; originalname: string } | undefined
  ): Promise<LineAliasesMergeDto> {
    this.keeper(caller, workspaceId)
    if (!file) throw new BadRequestException('Choose the file of names')
    const grid = await readGrid(file.buffer, file.originalname)
    const listed = namesFileOf(grid)
    if (listed) return this.mergeNames(caller, workspaceId, file, listed)
    const read = accountMappingOf(grid, file.originalname)
    const accounts = Object.keys(read.accounts)
    if (!accounts.length)
      throw new BadRequestException(
        `${file.originalname}: no accounts found. An account mapping has a column of accounts and one of the category each bills to.`
      )
    if (accounts.length > MAX_ACCOUNTS)
      throw new BadRequestException('The file has too many accounts')
    const engagements = await this.engagements(workspaceId)
    const found = engagementOfMapping(
      read,
      engagements.map((x) => ({
        id: x.id,
        name: x.name,
        number: x.number,
        code: x.code,
        periodStart: day(x.periodStart),
        periodEnd: day(x.periodEnd),
        budgets: [
          x.budgetLines.reduce((t, b) => t + Number(b.amount), 0),
          ...(x.awardAmount ? [Number(x.awardAmount)] : []),
        ],
      }))
    )
    const e = found ? (engagements.find((x) => x.id === found.id) ?? null) : null
    const entries = mappingNames(
      read,
      e
        ? e.budgetLines.map((b, i) => ({ id: String(i), name: b.name, amount: Number(b.amount) }))
        : null
    )
    const known = new Set(
      engagements.flatMap((x) => (x === e || !e ? x.budgetLines.map((b) => aliasKey(b.name)) : []))
    )
    let added = 0
    let same = 0
    let skipped = 0
    const sha256 = createHash('sha256').update(file.buffer).digest('hex')
    await this.log.change(
      caller,
      async (tx) => {
        const rows = await this.rows(workspaceId, tx)
        for (const { name, budgetLineName: target } of entries) {
          if (!aliasKey(name)) {
            skipped++
            continue
          }
          if (!target && !e) {
            skipped++
            continue
          }
          // A category whose line is on no engagement it could go to waits for a person: never a name to nowhere.
          if (target && !known.has(aliasKey(target))) {
            skipped++
            continue
          }
          const w = e
            ? writeFor({ name, engagementId: e.id, budgetLineName: target }, rows)
            : !rows.some((r) => r.engagementId === null && aliasKey(r.name) === aliasKey(name))
              ? { name, engagementId: null, budgetLineName: target, unallowable: false }
              : null
          if (!w) {
            same++
            continue
          }
          if (rows.length >= MAX_LINE_ALIASES && !this.has(rows, w)) {
            skipped++
            continue
          }
          this.keep(rows, await this.put(tx, caller, workspaceId, w))
          added++
        }
      },
      () => ({
        workspaceId,
        resource: 'workspace',
        subjectId: workspaceId,
        action: 'update',
        description: e
          ? `Added QuickBooks names from the account mapping of ${e.name}`
          : 'Added QuickBooks names from an account mapping file',
        changes: [
          { field: 'Accounts in the file', after: String(accounts.length) },
          { field: 'Names added or changed', after: String(added) },
          { field: 'File SHA-256', after: sha256 },
        ],
      }),
      // A chart of accounts runs to a few hundred writes.
      { timeout: 30_000 }
    )
    return {
      ...(await this.dto(workspaceId)),
      added,
      same,
      skipped,
      engagementName: e?.name ?? null,
    }
  }

  /**
   * The Bulk Add Names file: each row's name to its budget line or Unallowable, on the workspace or, when the row names
   * one, on that engagement. It adds and never changes: a name already on the workspace's list stays as it is (on an
   * engagement, `writeFor` keeps only an answer that differs). A row whose line or engagement isn't found is left out.
   */
  private async mergeNames(
    caller: Caller,
    workspaceId: string,
    file: { buffer: Buffer; originalname: string },
    listed: NamesFileRow[]
  ): Promise<LineAliasesMergeDto> {
    if (!listed.length)
      throw new BadRequestException(
        `${file.originalname}: no categories found under "Financial category"`
      )
    if (listed.length > MAX_ACCOUNTS) throw new BadRequestException('The file has too many names')
    const engagements = await this.engagements(workspaceId)
    const engagementOf = (said: string) =>
      engagements.find((x) =>
        [x.name, x.number, x.code].some((v) => v && aliasKey(v) === aliasKey(said))
      ) ?? null
    const lineOn = (lines: { name: string }[], said: string) =>
      lines.find((b) => aliasKey(b.name) === aliasKey(said))?.name ?? null
    let added = 0
    let same = 0
    let skipped = 0
    const sha256 = createHash('sha256').update(file.buffer).digest('hex')
    await this.log.change(
      caller,
      async (tx) => {
        const rows = await this.rows(workspaceId, tx)
        for (const r of listed) {
          const e = r.engagement ? engagementOf(r.engagement) : null
          const line =
            r.goesTo === null
              ? null
              : lineOn(e ? e.budgetLines : engagements.flatMap((x) => x.budgetLines), r.goesTo)
          if (!aliasKey(r.name) || r.goesTo === '' || (r.engagement && !e) || (r.goesTo && !line)) {
            skipped++
            continue
          }
          const w: AliasWrite | null = e
            ? writeFor({ name: r.name, engagementId: e.id, budgetLineName: line }, rows)
            : rows.some((x) => x.engagementId === null && aliasKey(x.name) === aliasKey(r.name))
              ? null
              : {
                  name: r.name,
                  engagementId: null,
                  budgetLineName: line,
                  unallowable: line === null,
                }
          if (!w) {
            same++
            continue
          }
          if (rows.length >= MAX_LINE_ALIASES && !this.has(rows, w)) {
            skipped++
            continue
          }
          this.keep(rows, await this.put(tx, caller, workspaceId, w))
          added++
        }
      },
      () => ({
        workspaceId,
        resource: 'workspace',
        subjectId: workspaceId,
        action: 'update',
        description: 'Added QuickBooks names from a Bulk Add Names file',
        changes: [
          { field: 'Names in the file', after: String(listed.length) },
          { field: 'Names added or changed', after: String(added) },
          { field: 'File SHA-256', after: sha256 },
        ],
      }),
      { timeout: 30_000 }
    )
    return { ...(await this.dto(workspaceId)), added, same, skipped, engagementName: null }
  }
}
