import { mergeProgramNames, namesOfEngagement, programOf, unsetPrograms } from '@ad/types'
import { cleanProgramNames, programNameRows } from './program-names'

/** Fictional programs throughout. */
describe('program names (owner, 2026-11-01)', () => {
  const csv = (text: string) => Buffer.from(text)

  it("reads a mapping file's rows as one program's names each, without its header or notes in brackets", async () => {
    const rows = await programNameRows(
      csv(
        'Class in the books,Payroll project\n' +
          'Youth - Board ISY,Board (In-School Youth 2026)\n' +
          'General & Admin,(Leave blank)\n' +
          'Adult IT Training,\n'
      ),
      'mapping.csv'
    )
    expect(rows).toEqual([
      ['Youth - Board ISY', 'Board (In-School Youth 2026)'],
      ['General & Admin'],
      ['Adult IT Training'],
    ])
  })

  it('reads as many names per program as the file has columns, under an alias header, and joins rows that share one', async () => {
    const rows = await programNameRows(
      csv(
        'Program,Alias 1,Alias 2,Alias 3\n' +
          'Youth Coding,Youth - Coding (class),Coding Pathway (payroll),YCP\n' +
          'Adult IT,Adult IT Training,,\n' +
          'YCP,Youth Coding Pathway 2027,,\n'
      ),
      'aliases.csv'
    )
    expect(rows).toEqual([
      ['Youth Coding', 'Youth - Coding (class)', 'Coding Pathway (payroll)', 'YCP'],
      ['Adult IT', 'Adult IT Training'],
      ['YCP', 'Youth Coding Pathway 2027'],
    ])
    expect(mergeProgramNames([], rows).programs.map((g) => g.names)).toEqual([
      [
        'Youth Coding',
        'Youth - Coding (class)',
        'Coding Pathway (payroll)',
        'YCP',
        'Youth Coding Pathway 2027',
      ],
      ['Adult IT', 'Adult IT Training'],
    ])
    // A header that is only "Program" or "Programs" is no program either.
    expect(await programNameRows(csv('Programs\nHarbor Camp\n'), 'one.csv')).toEqual([
      ['Harbor Camp'],
    ])
  })

  it('merges each file with the list: a row joins the program that has any of its names, nothing is dropped', () => {
    const { programs: had } = mergeProgramNames([], [['Youth - Board ISY'], ['Adult IT Training']])
    had[0]!.engagementId = 'e-isy'
    const { programs, conflicts } = mergeProgramNames(had, [
      ['youth - board isy', 'Board (In-School Youth 2026)'],
      ['Board (In-School Youth 2026)', 'Adult IT Training'],
      ['Harbor Camp'],
    ])
    // The second row names both programs: they are one now, keeping the engagement linked.
    expect(programs).toEqual([
      {
        names: ['Youth - Board ISY', 'Board (In-School Youth 2026)', 'Adult IT Training'],
        engagementId: 'e-isy',
      },
      { names: ['Harbor Camp'], engagementId: null },
    ])
    expect(conflicts).toEqual([])
  })

  it('never joins two programs linked to different engagements: the row is left out and said', () => {
    const had = [
      { names: ['Youth Board'], engagementId: 'e-isy' },
      { names: ['Adult Board'], engagementId: 'e-ait' },
    ]
    const { programs, conflicts } = mergeProgramNames(had, [
      ['Workforce Board', 'Youth Board'],
      ['Workforce Board', 'Adult Board'],
    ])
    expect(programs).toEqual([
      { names: ['Youth Board', 'Workforce Board'], engagementId: 'e-isy' },
      { names: ['Adult Board'], engagementId: 'e-ait' },
    ])
    expect(conflicts).toEqual([['Workforce Board', 'Adult Board']])
  })

  it('reads a mapping file with no header row from its first row', async () => {
    expect(
      await programNameRows(csv('Youth - Board ISY,Board (In-School Youth 2026)\n'), 'm.csv')
    ).toEqual([['Youth - Board ISY', 'Board (In-School Youth 2026)']])
  })

  it("finds an engagement's program by its link, else by its name", () => {
    const list = [
      { names: ['Youth - Board ISY', 'Board (In-School Youth 2026)'], engagementId: 'e-isy' },
      { names: ['Adult IT Training', 'Adults - AIT'], engagementId: null },
    ]
    expect(namesOfEngagement(list, { id: 'e-isy', name: 'In-School Youth 2026-27' })).toEqual([
      'In-School Youth 2026-27',
      'Youth - Board ISY',
      'Board (In-School Youth 2026)',
    ])
    expect(programOf(list, { id: 'e-ait', name: 'adult it training' })).toBe(list[1])
    expect(programOf(list, { id: 'e-osy', name: 'Out-of-School Youth' })).toBeNull()
  })

  it("checks an owner's list: names as text, engagements of the workspace only", () => {
    const ids = new Set(['e-isy'])
    expect(cleanProgramNames([{ names: [' A ', 'B'], engagementId: 'e-isy' }], ids)).toEqual([
      { names: ['A', 'B'], engagementId: 'e-isy' },
    ])
    expect(() => cleanProgramNames([{ names: ['A'], engagementId: 'e-other' }], ids)).toThrow(
      /engagement of this workspace/
    )
    expect(() => cleanProgramNames([{ names: [] }], ids)).toThrow(/at least one name/)
    const many = Array.from({ length: 21 }, (_, i) => `Harbor Camp ${i + 1}`)
    expect(() => cleanProgramNames([{ names: many }], ids)).toThrow(
      /"Harbor Camp 1" has 21 names: a program keeps up to 20/
    )
    expect(() => cleanProgramNames('x', ids)).toThrow(/list of programs/)
    expect(() => cleanProgramNames([{ names: ['A'] }, { names: ['a', 'B'] }], ids)).toThrow(
      /one program only/
    )
    expect(() =>
      cleanProgramNames(
        [
          { names: ['A'], engagementId: 'e-isy' },
          { names: ['B'], engagementId: 'e-isy' },
        ],
        ids
      )
    ).toThrow(/linked to one program only/)
    expect(cleanProgramNames([{ names: ['A'], engagementId: 'none' }], ids)).toEqual([
      { names: ['A'], engagementId: 'none' },
    ])
  })

  it('counts a program as not set until it is linked, one by its name, or marked not one of ours', () => {
    const list = [
      { names: ['Board (In-School Youth 2026)'], engagementId: 'e-isy' },
      { names: ['Adult Tech Training'], engagementId: null },
      { names: ['Summer Camp'], engagementId: 'none' },
      { names: ['Youth - Board Pathway'], engagementId: null },
    ]
    const engagements = [
      { id: 'e-isy', name: 'In-School Youth 2026' },
      { id: 'e-ait', name: 'Adult Tech Training' },
    ]
    expect(unsetPrograms(list, engagements).map((g) => g.names[0])).toEqual([
      'Youth - Board Pathway',
    ])
  })
})
