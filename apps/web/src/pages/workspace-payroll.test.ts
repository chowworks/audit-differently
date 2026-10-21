import { describe, expect, it } from 'vitest'
import type { PayrollSlotMatch, WorkspacePayrollItemDto } from '@ad/types'
import { distinctFileCount, ownLinks, sha256Hex } from './workspace-payroll'

const item = (id: string, proved: WorkspacePayrollItemDto['proved'] = []) =>
  ({ target: 'expense', id, kind: 'staff', proved }) as WorkspacePayrollItemDto
const slot = (
  id: string,
  s: PayrollSlotMatch['slot'],
  pick: string | null,
  sure: boolean,
  mark = true
): PayrollSlotMatch => ({
  target: 'expense',
  id,
  slot: s,
  pick,
  why: '',
  candidates: ['f1', 'f2'].map((fileId) => ({
    fileId,
    mark: mark
      ? { page: 1, x: 0, y: 0, w: 1, h: 1, width: 612, height: 792, text: 'Morgan Lee 1,200.00' }
      : null,
    marks: [],
    sure: fileId === pick && sure,
    score: 1,
    why: '',
  })),
})

describe('which links Save sends', () => {
  const run = {
    items: [item('a'), item('b', ['timesheet'])],
    slots: [
      slot('a', 'timesheet', 'f1', true),
      slot('a', 'register', 'f1', false),
      slot('a', 'bank', 'f1', true, false),
      slot('b', 'register', 'f1', true),
    ],
  }

  it("sends nothing for Auto-Match's own picks: the server links its sure ones itself", () => {
    expect(ownLinks(run, {}, new Set())).toEqual([])
  })

  it('sends a file the owner chose instead of the pick, and a guess the owner confirmed', () => {
    const links = ownLinks(
      run,
      { 'expense-b': { register: 'f2' } },
      new Set(['expense-a-register'])
    )
    expect(links).toEqual([
      { target: 'expense', id: 'a', slot: 'register', fileId: 'f1' },
      { target: 'expense', id: 'b', slot: 'register', fileId: 'f2' },
    ])
  })

  it('takes a guess chosen by hand as confirmed, but not a sure pick chosen again', () => {
    expect(ownLinks(run, { 'expense-a': { register: 'f1', timesheet: 'f1' } }, new Set())).toEqual([
      { target: 'expense', id: 'a', slot: 'register', fileId: 'f1' },
    ])
  })

  it('never sends a bank statement with no line found, nor a proof already on file', () => {
    expect(
      ownLinks(
        run,
        { 'expense-a': { bank: 'f2' }, 'expense-b': { timesheet: 'f2' } },
        new Set(['expense-a-bank'])
      )
    ).toEqual([])
  })
})

describe('counting the different files of a zip', () => {
  it('counts the same contents once', async () => {
    const files = [new Blob(['a']), new Blob(['b']), new Blob(['a'])]
    expect(await distinctFileCount(files)).toBe(2)
    expect(await distinctFileCount([])).toBe(0)
  })

  it('hashes the contents as sha256 hex', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})
