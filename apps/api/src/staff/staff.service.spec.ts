import type { StaffInputProblem } from '@ad/types'
import { member, stranger, W } from '../core/testing/callers'
import { StaffService } from './staff.service'

/** The staff list (GitHub issue #22). Fictional people and programs. */
const owner = member('owner')
const bookkeeper = member('bookkeeper')
const auditor = member('auditor')

type Row = {
  id: string
  workspaceId: string
  name: string
  role: string | null
  createdAt: Date
  proofs: number
  engagements: string[]
}

function setup() {
  const engagements = [
    { id: 'e-isy', workspaceId: W, name: 'In-School Youth Coding Pathway', status: 'active' },
    { id: 'e-osy', workspaceId: W, name: 'Out-of-School Youth Bridge', status: 'active' },
    { id: 'e-other', workspaceId: 'ws-2', name: 'Elsewhere', status: 'active' },
  ]
  const staff: Row[] = [
    {
      id: 's-morgan',
      workspaceId: W,
      name: 'Morgan Lee',
      role: 'Instructor',
      createdAt: new Date(),
      proofs: 0,
      engagements: ['e-isy'],
    },
    {
      id: 's-avery',
      workspaceId: W,
      name: 'Avery Stone',
      role: null,
      createdAt: new Date(),
      proofs: 2,
      engagements: [],
    },
  ]
  const asRow = (s: Row) => ({
    ...s,
    _count: { payProofs: s.proofs },
    assignments: s.engagements.map((id) => ({
      id: `a-${s.id}-${id}`,
      engagementId: id,
      engagement: engagements.find((e) => e.id === id)!,
    })),
  })
  const tx = {
    staffMember: {
      createMany: jest.fn(async ({ data }: { data: Omit<Row, 'id'>[] }) => {
        for (const d of data)
          staff.push({
            ...d,
            id: `s-${staff.length}`,
            createdAt: new Date(),
            proofs: 0,
            engagements: [],
          } as Row)
        return { count: data.length }
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) =>
        Object.assign(
          staff.find((s) => s.id === where.id)!,
          data
        )
      ),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        staff.splice(
          staff.findIndex((s) => s.id === where.id),
          1
        )
      }),
    },
    staffAssignment: {
      create: jest.fn(
        async ({ data }: { data: { staffMemberId: string; engagementId: string } }) => {
          staff.find((s) => s.id === data.staffMemberId)!.engagements.push(data.engagementId)
        }
      ),
      deleteMany: jest.fn(async ({ where }: { where: { id: string } }) => {
        for (const s of staff)
          s.engagements = s.engagements.filter((e) => `a-${s.id}-${e}` !== where.id)
      }),
    },
  }
  const participants = [
    { workspaceId: W, displayName: 'Jordan Sample', engagement: engagements[0]! },
    { workspaceId: W, displayName: 'Jordan Sample', engagement: engagements[1]! },
    { workspaceId: 'ws-2', displayName: 'Quinn Elsewhere', engagement: engagements[2]! },
  ]
  const inSight = (workspaceIds: string[]) => (s: { workspaceId: string }) =>
    workspaceIds.includes(s.workspaceId)
  const prisma = {
    staffMember: {
      findMany: jest.fn(async ({ where }: { where: { workspaceId: string } }) =>
        staff.filter((s) => s.workspaceId === where.workspaceId).map(asRow)
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; workspaceId: { in: string[] } } }) =>
          staff
            .filter(inSight(where.workspaceId.in))
            .map(asRow)
            .find((s) => s.id === where.id) ?? null
      ),
    },
    participant: {
      findMany: jest.fn(async ({ where }: { where: { workspaceId: string } }) =>
        participants.filter((p) => p.workspaceId === where.workspaceId)
      ),
    },
    engagement: {
      findMany: jest.fn(async ({ where }: { where: { workspaceId: string } }) =>
        engagements.filter((e) => e.workspaceId === where.workspaceId)
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; workspaceId: string } }) =>
          engagements.find((e) => e.id === where.id && e.workspaceId === where.workspaceId) ?? null
      ),
    },
    staffAssignment: {
      findFirst: jest.fn(
        async ({ where }: { where: { staffMemberId: string; engagementId: string } }) => {
          const s = staff.find((x) => x.id === where.staffMemberId)
          return s?.engagements.includes(where.engagementId)
            ? {
                id: `a-${s.id}-${where.engagementId}`,
                engagement: engagements.find((e) => e.id === where.engagementId)!,
              }
            : null
        }
      ),
    },
  }
  const lines: { description: string; changes?: unknown }[] = []
  const log = {
    log: jest.fn(async (_c: unknown, e: { description: string }) => void lines.push(e)),
    change: jest.fn(
      async (
        _c: unknown,
        write: (t: typeof tx) => Promise<unknown>,
        entry: { description: string }
      ) => {
        const out = await write(tx)
        lines.push(entry)
        return out
      }
    ),
  }
  return { service: new StaffService(prisma as never, log as never), staff, tx, lines, prisma, log }
}

const problemsOf = async (p: Promise<unknown>): Promise<StaffInputProblem[]> => {
  try {
    await p
  } catch (e) {
    return (e as { getResponse: () => { problems: StaffInputProblem[] } }).getResponse().problems
  }
  throw new Error('expected a refusal')
}

describe('StaffService', () => {
  describe('who', () => {
    it('lets owners and auditors read the list, and nobody else, with one read line', async () => {
      const s = setup()
      const out = await s.service.list(owner, W)
      expect(
        out.staff.map((p) => [p.name, p.engagements.map((e) => e.name), p.inSavedProof])
      ).toEqual([
        ['Morgan Lee', ['In-School Youth Coding Pathway'], false],
        ['Avery Stone', [], true],
      ])
      expect(out.engagements.map((e) => e.id)).toEqual(['e-isy', 'e-osy'])
      expect(out.can.change).toBe(true)
      expect((await s.service.list(auditor, W)).can.change).toBe(false)
      expect(s.lines.map((l) => l.description)).toEqual([
        'Opened the staff list (2 people)',
        'Opened the staff list (2 people)',
      ])
      // A bookkeeper, or a member of another workspace, finds nothing here.
      await expect(s.service.list(bookkeeper, W)).rejects.toThrow(/Not Found/)
      await expect(s.service.list(stranger(), W)).rejects.toThrow(/Not Found/)
    })

    it('lets an owner alone change it: an auditor is refused, a bookkeeper finds nothing', async () => {
      const s = setup()
      const row = { staff: [{ name: 'Pat Doe' }] }
      await expect(s.service.add(auditor, W, row)).rejects.toThrow(/Only an owner/)
      await expect(s.service.add(bookkeeper, W, row)).rejects.toThrow(/Not Found/)
      await expect(s.service.update(auditor, 's-morgan', { name: 'M' })).rejects.toThrow(
        /Only an owner/
      )
      await expect(s.service.update(bookkeeper, 's-morgan', { name: 'M' })).rejects.toThrow(
        /Not Found/
      )
      await expect(s.service.remove(stranger(), 's-morgan')).rejects.toThrow(/Not Found/)
      await expect(s.service.assign(auditor, 's-morgan', 'e-osy')).rejects.toThrow(/Only an owner/)
      await expect(s.service.unassign(bookkeeper, 's-morgan', 'e-isy')).rejects.toThrow(/Not Found/)
      expect(s.log.change).not.toHaveBeenCalled()
    })
  })

  describe('the paste import', () => {
    it('adds every row at once, with one line naming how many', async () => {
      const s = setup()
      const out = await s.service.add(owner, W, {
        staff: [
          { name: '  Casey   Demo ', role: 'Case manager' },
          { name: 'Riley Example', role: '' },
          { name: 'Taylor Brook' },
          // Another workspace's participant is no clash.
          { name: 'Quinn Elsewhere' },
        ],
      })
      expect(s.tx.staffMember.createMany).toHaveBeenCalledWith({
        data: [
          { workspaceId: W, name: 'Casey Demo', role: 'Case manager' },
          { workspaceId: W, name: 'Riley Example', role: null },
          { workspaceId: W, name: 'Taylor Brook', role: null },
          { workspaceId: W, name: 'Quinn Elsewhere', role: null },
        ],
      })
      expect(out.staff).toHaveLength(6)
      expect(out.staff[0]).not.toHaveProperty('employeeNumber')
      expect(s.lines.map((l) => l.description)).toEqual(['Added 4 staff'])
      // One person: named, with the fields they gave by name alone. An employee number sent anyway is not kept.
      await s.service.add(owner, W, {
        staff: [{ name: 'Sam Example', role: 'Bootcamp leader', employeeNumber: '77' } as never],
      })
      expect(s.tx.staffMember.createMany).toHaveBeenLastCalledWith({
        data: [{ workspaceId: W, name: 'Sam Example', role: 'Bootcamp leader' }],
      })
      expect(s.lines[1]).toEqual(
        expect.objectContaining({
          description: 'Added Sam Example to the staff list',
          changes: [{ field: 'Name' }, { field: 'Role' }],
        })
      )
    })

    it('reports every problem at once, each beside its row and field, and adds nobody', async () => {
      const s = setup()
      const problems = await problemsOf(
        s.service.add(owner, W, {
          staff: [
            { name: '' },
            { name: 'morgan  LEE ' },
            { name: 'Riley Example', role: 'Instructor' },
            { name: 'riley example' },
            { name: 'Jordan Sample' },
            { name: 'Avery Stone', role: 'Case manager' },
            { name: 'Jamie Doe', role: 'x'.repeat(81) },
          ],
        })
      )
      expect(problems).toEqual([
        { row: 1, field: 'name', message: 'Row 1: the name is missing' },
        {
          row: 2,
          field: 'name',
          message:
            'Row 2: morgan LEE is already on the staff list: add something to tell them apart, e.g. morgan LEE (their engagement)',
        },
        {
          row: 4,
          field: 'name',
          message:
            'Row 4: riley example is also on row 3: add something to tell them apart, e.g. riley example (their engagement)',
        },
        {
          row: 5,
          field: 'name',
          message:
            'Row 5: Jordan Sample is a participant on In-School Youth Coding Pathway and Out-of-School Youth Bridge: add something to tell them apart',
        },
        {
          row: 6,
          field: 'name',
          message:
            'Row 6: Avery Stone is already on the staff list: add something to tell them apart, e.g. Avery Stone (Case manager)',
        },
        { row: 7, field: 'role', message: 'Row 7: the role is over 80 characters' },
      ])
      expect(s.tx.staffMember.createMany).not.toHaveBeenCalled()
      // A name told apart is added.
      await s.service.add(owner, W, {
        staff: [{ name: 'Morgan Lee (Adult IT)' }, { name: 'Jordan Sample (staff)' }],
      })
      expect(s.tx.staffMember.createMany).toHaveBeenCalledTimes(1)
      await expect(s.service.add(owner, W, { staff: [] })).rejects.toThrow(/at least one/)
      await expect(
        s.service.add(owner, W, {
          staff: Array.from({ length: 501 }, (_, i) => ({ name: `P ${i}` })),
        })
      ).rejects.toThrow(/at most 500/)
    })

    it('says a name two tabs added at once is taken, in plain words', async () => {
      const s = setup()
      s.log.change.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      await expect(s.service.add(owner, W, { staff: [{ name: 'Pat Doe' }] })).rejects.toThrow(
        'That name is already on the staff list: add something to tell them apart'
      )
    })
  })

  describe('a person', () => {
    it('changes their details, logged by field name alone, and refuses a name already taken', async () => {
      const s = setup()
      await s.service.update(owner, 's-morgan', { name: 'Morgan Lee', role: 'Lead instructor' })
      expect(s.lines).toEqual([
        expect.objectContaining({
          description: "Changed Morgan Lee's details on the staff list",
          changes: [{ field: 'Role' }],
        }),
      ])
      // The same again changes nothing; their own name in another case is no clash.
      await s.service.update(owner, 's-morgan', { name: 'Morgan Lee', role: 'Lead instructor' })
      expect(s.lines).toHaveLength(1)
      await s.service.update(owner, 's-morgan', { name: 'Morgan LEE', role: 'Lead instructor' })
      expect(s.lines).toHaveLength(2)
      expect(
        await problemsOf(s.service.update(owner, 's-morgan', { name: 'avery stone' }))
      ).toEqual([
        {
          row: 1,
          field: 'name',
          message:
            'Row 1: avery stone is already on the staff list: add something to tell them apart, e.g. avery stone (their engagement)',
        },
      ])
      expect(
        await problemsOf(s.service.update(owner, 's-morgan', { name: 'Jordan Sample' }))
      ).toEqual([
        {
          row: 1,
          field: 'name',
          message:
            'Row 1: Jordan Sample is a participant on In-School Youth Coding Pathway and Out-of-School Youth Bridge: add something to tell them apart',
        },
      ])
    })

    it('keeps a name as it is when a participant of that name was added since', async () => {
      const s = setup()
      s.staff[0]!.name = 'Jordan Sample'
      await s.service.update(owner, 's-morgan', { name: 'Jordan Sample', role: 'Lead instructor' })
      expect(s.lines.map((l) => l.description)).toEqual([
        "Changed Jordan Sample's details on the staff list",
      ])
    })

    it('removes a person not in saved payroll proof, and keeps one who is', async () => {
      const s = setup()
      await expect(s.service.remove(owner, 's-avery')).rejects.toThrow(
        'Avery Stone is in saved payroll proof, so stays on the staff list. Take them off their engagements instead.'
      )
      const out = await s.service.remove(owner, 's-morgan')
      expect(out.staff.map((p) => p.name)).toEqual(['Avery Stone'])
      expect(s.lines.map((l) => l.description)).toEqual(['Removed Morgan Lee from the staff list'])
    })

    it('puts a person on an engagement of the workspace and takes them off, each once, in the screen’s words', async () => {
      const s = setup()
      const out = await s.service.assign(owner, 's-morgan', 'e-osy')
      expect(out.staff.find((p) => p.id === 's-morgan')!.engagements.map((e) => e.id)).toEqual([
        'e-isy',
        'e-osy',
      ])
      await s.service.assign(owner, 's-morgan', 'e-osy')
      await s.service.unassign(owner, 's-morgan', 'e-isy')
      await s.service.unassign(owner, 's-morgan', 'e-isy')
      expect(s.lines.map((l) => l.description)).toEqual([
        'Put Morgan Lee on Out-of-School Youth Bridge',
        'Took Morgan Lee off In-School Youth Coding Pathway',
      ])
      // Another workspace's engagement is not there.
      await expect(s.service.assign(owner, 's-morgan', 'e-other')).rejects.toThrow(/Not Found/)
    })
  })
})
