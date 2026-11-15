import { describe, expect, it } from 'vitest'
import type {
  PayLineDto,
  PlanFileDto,
  PlanProofDto,
  StaffFoundDto,
  StubPayDto,
  WorkspacePayrollItemDto,
  WorkspacePayrollRunDto,
} from '@ad/types'
import {
  alreadyComplete,
  filesWords,
  missingAfterSave,
  paymentWords,
  paymentsWords,
  proofList,
  proofWords,
  provedRows,
  staffMissingWhy,
  staffRows,
  staffWords,
} from './workspace-payroll-plan'

// The fictional September sample on the demo seed, as the API's plan answers it
// (apps/api/src/payroll/workspace-payroll.sample-plan.spec.ts), cut down to what the words read.
const ISY = { id: 'e-isy', name: 'In-School Youth Coding Pathway' }
const AIT = { id: 'e-ait', name: 'Adult IT Training' }
const staff = (name: string, engagements: { id: string; name: string }[], pay: number) =>
  ({
    staffId: `s-${name}`,
    name,
    engagements,
    pay,
    timesheet: ['f-ts'],
    register: ['f-reg'],
    bank: ['f-bank'],
    bankGuess: [],
    charged: [],
    payByRun: [{ payDate: null, amount: pay }],
    found: {
      timesheet: [{ fileId: 'f-ts', mark: null }],
      register: [{ fileId: 'f-reg', mark: { page: 1, x: 0, y: 0, width: 1, height: 1, text: '' } }],
      bank: [{ fileId: 'f-bank', mark: null, run: true }],
      bankGuess: [],
    },
  }) as StaffFoundDto
const stub = (
  name: string,
  action: StubPayDto['action'],
  previousAmount: number | null,
  grossAmount: number
) =>
  ({
    fileId: `f-stub-${name}`,
    fileName: `Pay stub ${name}.pdf`,
    participant: { id: `p-${name}`, name, engagementName: ISY.name },
    action,
    previousAmount,
    grossAmount,
    flags: [],
  }) as unknown as StubPayDto
const item = (
  id: string,
  kind: 'staff' | 'participant',
  sub: string,
  e = ISY,
  proved: WorkspacePayrollItemDto['proved'] = []
) =>
  ({
    target: kind === 'staff' ? 'expense' : 'wex',
    id,
    kind,
    sub,
    title: id,
    engagementId: e.id,
    engagementName: e.name,
    reportId: `r-${e.id}`,
    proved,
  }) as WorkspacePayrollItemDto
const proofFor = (i: WorkspacePayrollItemDto, people: string[]): PlanProofDto => ({
  target: i.target,
  id: i.id,
  stubFileId: null,
  title: i.title,
  engagementId: i.engagementId,
  engagementName: i.engagementName,
  reportId: i.reportId,
  files: (i.kind === 'staff'
    ? (['timesheet', 'register', 'bank'] as const)
    : (['stub', 'timesheet', 'register'] as const)
  ).map((slot) => ({
    fileId: `f-${slot}`,
    fileName: `${slot}.pdf`,
    kind: 'timesheet',
    slot,
    people,
  })),
})

const items = [
  item('RYS-13', 'staff', 'wex', ISY, ['timesheet', 'register', 'bank']),
  item('RYS-18', 'staff', 'staff-salaries', ISY, ['timesheet', 'register']),
  item('RYS-20', 'staff', 'staff-salaries'),
  item('AIT-1', 'staff', 'staff-salaries', AIT),
  item('Jordan', 'participant', '900001', ISY, ['timesheet', 'register', 'stub']),
  item('Riley', 'participant', '900002', ISY, ['timesheet', 'register']),
  item('Casey', 'participant', '900003', ISY, ['timesheet', 'register', 'stub']),
]
const file = (
  id: string,
  kind: PlanFileDto['kind'],
  engagements: { id: string; name: string }[]
): PlanFileDto => ({
  fileId: id,
  fileName: `${id}.pdf`,
  kind,
  engagements,
})
const run = (over: Partial<WorkspacePayrollRunDto['plan']> = {}) =>
  ({
    items,
    slots: [],
    files: [
      { id: 'f-ts', kind: 'timesheet', fileName: 'f-ts.pdf' },
      { id: 'f-reg', kind: 'payroll-register', fileName: 'f-reg.pdf' },
      { id: 'f-bank', kind: 'bank-statement', fileName: 'f-bank.pdf' },
    ],
    pays: [
      { id: 'b:7', state: 'unassigned', flags: ['not-on-a-list'] },
      { id: 'b:1', state: 'matched', flags: [] },
      // A participant's bank line: their pay stub is the proof, so it is not listed as going nowhere.
      { id: 'b:5', state: 'unassigned', flags: [] },
      { id: 'r:9', state: 'unassigned', flags: ['staff-untagged'] },
    ] as PayLineDto[],
    plan: {
      staff: [
        staff('Morgan Lee', [ISY, AIT], 2400),
        staff('Priya Shah', [ISY], 1800),
        staff('Sam Ortiz', [AIT], 2000),
        { ...staff('Avery Stone', [], 0), timesheet: [], register: [], bank: [], pay: null },
      ],
      stubs: [
        stub('Jordan Sample', 'update', 280, 280),
        stub('Riley Example', 'update', 224, 224),
        stub('Casey Demo', 'update', 300, 280),
      ],
      links: 18,
      unlinks: 0,
      alreadyOnFile: 0,
      twoProofs: [],
      unlisted: [],
      payments: { create: 0, update: 3, remove: 0 },
      files: [
        file('f-ts', 'timesheet', [ISY, AIT]),
        file('f-reg', 'payroll-register', [ISY, AIT]),
        file('f-bank', 'bank-statement', [ISY, AIT]),
        file('f-stub-1', 'paystub', [ISY]),
        file('f-stub-2', 'paystub', [ISY]),
        file('f-stub-3', 'paystub', [ISY]),
      ],
      proof: [
        proofFor(items[1]!, ['Morgan Lee', 'Priya Shah']),
        proofFor(items[2]!, ['Morgan Lee', 'Priya Shah']),
        proofFor(items[3]!, ['Morgan Lee', 'Sam Ortiz']),
        proofFor(items[4]!, ['Jordan Sample']),
        proofFor(items[5]!, ['Riley Example']),
        proofFor(items[6]!, ['Casey Demo']),
      ],
      ...over,
    },
  }) as unknown as WorkspacePayrollRunDto

describe('step 2 of the workspace payroll page, in words', () => {
  it('counts the items fully proved after Save, with the file of each proof', () => {
    const r = run()
    expect(provedRows(r, proofList(r, [])).map((p) => p.title)).toEqual(items.map((i) => i.title))
    // Nobody found for Adult IT: its line is not fully proved.
    r.plan.proof = r.plan.proof.filter((p) => p.id !== 'AIT-1')
    const rows = provedRows(r, proofList(r, []))
    expect(rows).toHaveLength(6)
    // Proof on file has no file named here; proof Save attaches does.
    expect(rows.find((p) => p.title === 'RYS-13')!.proofs.map((f) => f.file)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(rows.find((p) => p.title === 'RYS-18')!.proofs.map((f) => f.file)).toEqual([
      'timesheet.pdf',
      'register.pdf',
      'bank.pdf',
    ])
    // A payment a pay stub makes counts once Save attaches all three of its proofs.
    const made = run({
      proof: [
        {
          ...proofFor(item('x', 'participant', '900009'), ['Drew New']),
          id: null,
          stubFileId: 'f-stub-Drew',
          title: "Drew New's work-experience pay",
        },
      ],
      stubs: [{ ...stub('Drew New', 'create', null, 260), fileId: 'f-stub-Drew' }],
    })
    expect(provedRows({ ...made, items: [] }, proofList(made, [])).map((p) => p.amount)).toEqual([
      260,
    ])
  })

  it('lists staff found or tagged, never someone on the list alone', () => {
    expect(staffRows(run()).map((s) => s.name)).toEqual(['Morgan Lee', 'Priya Shah', 'Sam Ortiz'])
    expect(staffWords(run())).toBe(
      'Auto-matched 3 staff found in the files: Morgan Lee, Priya Shah, Sam Ortiz'
    )
  })

  it("says what Save does to each participant's payment, and to all of them", () => {
    expect(paymentWords(stub('Jordan', 'create', null, 280))).toBe('payment to make $280.00')
    expect(paymentWords(stub('Casey', 'update', 300, 280))).toBe(
      'payment corrected $300.00 → $280.00'
    )
    expect(paymentWords(stub('Riley', 'update', 224, 224))).toBe('no change')
    expect(paymentWords(stub('Riley', 'same', 224, 224))).toBe('no change')
    expect(paymentsWords(run())).toBe(
      'Matched 3 payments for 3 participants: 1 to correct, 2 unchanged'
    )
    const r = run({
      stubs: [
        stub('A', 'create', null, 280),
        stub('B', 'create', null, 224),
        stub('C', 'update', 300, 280),
        stub('D', 'none', null, 1),
      ],
      payments: { create: 2, update: 1, remove: 1 },
    })
    expect(paymentsWords(r)).toBe(
      'Matched 3 payments for 3 participants: 2 to make, 1 to correct, 1 to remove'
    )
  })

  it('counts the files that reach an engagement and those that reach nothing', () => {
    expect(filesWords(run(), []).line).toBe(
      '6 files: 6 matched to your engagements, 0 matched to nothing'
    )
    const r = run()
    r.plan.files.push(file('f-extra', 'timesheet', []))
    expect(filesWords(r, [])).toEqual({
      line: '7 files: 6 matched to your engagements, 1 matched to nothing',
      nowhere: ['f-extra.pdf'],
    })
    // A file the owner chose on the table reaches that item's engagement.
    expect(
      filesWords(r, [{ target: 'wex', id: 'Riley', slot: 'stub', fileId: 'f-extra' }]).line
    ).toBe('7 files: 7 matched to your engagements, 0 matched to nothing')
  })

  it('lists the proof attached by item, the owner’s own choices included', () => {
    // RYS-13 is fully proved already and gets nothing new: said, so the count matches the header's 7 items.
    expect(proofWords(run(), proofList(run(), []))).toBe(
      'Proof attached: 18 files to 6 payroll items (1 already complete)'
    )
    expect(alreadyComplete(run(), proofList(run(), [])).map((i) => i.id)).toEqual(['RYS-13'])
    expect(provedRows(run(), proofList(run(), []))).toHaveLength(6 + 1)
    const r = run({ proof: [] })
    const chosen = [{ target: 'wex' as const, id: 'Riley', slot: 'stub' as const, fileId: 'f-ts' }]
    expect(proofList(r, chosen).map((p) => [p.title, p.files.map((f) => f.slot)])).toEqual([
      ['Riley', ['stub']],
    ])
    expect(proofWords({ ...r, plan: { ...r.plan, unlinks: 2 } }, proofList(r, chosen))).toBe(
      'Proof attached: 1 file to 1 payroll item (3 already complete); 2 links removed'
    )
    // The same file already on file is linked from there, never a copy: said beside the count.
    expect(proofWords(run({ alreadyOnFile: 2 }), proofList(run(), []))).toBe(
      'Proof attached: 18 files to 6 payroll items (1 already complete, 2 already on file)'
    )
  })

  it("says why a staff line's proof is still missing", () => {
    const r = run({ proof: [] })
    const ait = items[3]!
    expect(missingAfterSave(ait, r.plan.proof)).toEqual(['timesheet', 'register', 'bank'])
    expect(staffMissingWhy(r, ait, 'register')).toBe(
      'Nobody tagged to this engagement was found in the payroll register'
    )
    const untagged = run({ staff: [] })
    expect(staffMissingWhy(untagged, ait, 'timesheet')).toBe(
      'Nobody is tagged to this engagement in Engagement staffing'
    )
    const noBank = { ...r, files: r.files.filter((f) => f.kind !== 'bank-statement') }
    expect(staffMissingWhy(noBank, ait, 'bank')).toBe('No bank statement in the files')
    const guessed = run({
      staff: [{ ...staff('Sam Ortiz', [AIT], 2000), bank: [], bankGuess: ['f-bank'] }],
    })
    expect(staffMissingWhy(guessed, ait, 'bank')).toBe(
      'Sam Ortiz: bank line guessed by amount, confirm it in the reconciliation after Save'
    )
  })

  it('counts payments and participants apart: one payment per pay run', () => {
    const twice = (
      name: string,
      action: StubPayDto['action'],
      prev: number | null,
      gross: number
    ) =>
      ({ ...stub(name, action, prev, gross), fileId: `f-${name}-${action}-${gross}` }) as StubPayDto
    const r = run({
      stubs: [
        twice('Jordan Sample', 'create', null, 140),
        twice('Riley Example', 'create', null, 112),
        twice('Casey Demo', 'create', null, 140),
        twice('Jordan Sample', 'update', 280, 280),
        twice('Riley Example', 'update', 224, 224),
        twice('Casey Demo', 'update', 300, 280),
      ],
      payments: { create: 3, update: 3, remove: 0 },
    })
    expect(paymentsWords(r)).toBe(
      'Matched 6 payments for 3 participants: 3 to make, 1 to correct, 2 unchanged'
    )
    expect(paymentsWords(run({ stubs: [stub('Jordan Sample', 'create', null, 140)] }))).toBe(
      'Matched 1 payment for 1 participant: 1 to make'
    )
  })
})
