import { changesOf, howMany, monthName, type Fields } from './changes'

const fields: Fields = {
  amount: { label: 'Amount', show: 'money' },
  date: { label: 'Date', show: 'date' },
  status: { label: 'Status', show: 'text' },
  sources: { label: 'Sources', show: 'list' },
  name: { label: 'Name' },
}

describe('changesOf', () => {
  it('keeps a value only for a field that shows it; any other field is its name alone', () => {
    expect(
      changesOf(
        null,
        { amount: '50', date: new Date('2026-09-02T00:00:00Z'), name: 'Jordan Sample' },
        fields
      )
    ).toEqual([
      { field: 'Amount', after: '50.00' },
      { field: 'Date', after: '2026-09-02' },
      { field: 'Name' },
    ])
  })

  it('on an update, lists only what the request set and what changed', () => {
    const before = { amount: 120, status: 'draft', name: 'Jordan Sample', sources: ['A'] }
    expect(changesOf(before, { amount: '120.00', status: 'submitted' }, fields)).toEqual([
      { field: 'Status', before: 'draft', after: 'submitted' },
    ])
    expect(changesOf(before, { name: 'Jordan Sample' }, fields)).toEqual([])
    expect(changesOf(before, { name: 'Riley Example', sources: ['A', 'B'] }, fields)).toEqual([
      { field: 'Sources', before: 'A', after: 'A, B' },
      { field: 'Name' },
    ])
  })

  it('on a removal, keeps what was there', () => {
    expect(changesOf({ amount: 75, name: 'x', status: null }, null, fields)).toEqual([
      { field: 'Amount', before: '75.00' },
      { field: 'Name' },
    ])
  })
})

describe('words', () => {
  it('says months and counts the way the screens do', () => {
    expect(monthName('2026-09')).toBe('September 2026')
    expect(howMany(1, 'file')).toBe('1 file')
    expect(howMany(3, 'file')).toBe('3 files')
  })
})

describe('labels', () => {
  it('shows a stored key in the words of the screen, and keeps a key it does not know', () => {
    const roles: Fields = {
      role: {
        label: 'Role',
        show: 'text',
        labels: { owner: 'Owner', bookkeeper: 'Bookkeeper', auditor: 'Auditor' },
      },
    }
    expect(changesOf({ role: 'bookkeeper' }, { role: 'auditor' }, roles)).toEqual([
      { field: 'Role', before: 'Bookkeeper', after: 'Auditor' },
    ])
    expect(changesOf(null, { role: 'funder' }, roles)).toEqual([{ field: 'Role', after: 'funder' }])
    expect(changesOf({ role: 'owner' }, { role: 'owner' }, roles)).toEqual([])
  })

  it('still keeps the name alone for a field that does not show its value', () => {
    expect(
      changesOf(null, { name: 'x' }, { name: { label: 'Name', labels: { x: 'Visible' } } })
    ).toEqual([{ field: 'Name' }])
  })
})
