import { describe, expect, it } from 'vitest'
import { besideField, checkStaff, leftOutWords, parseStaff, readStaffPaste } from './staff-paste'

describe('pasting the staff list', () => {
  it('reads tab or comma rows of a name and a role, and skips a heading row', () => {
    expect(parseStaff('Name\tRole\nMorgan Lee\tLead instructor\n\nPriya Shah')).toEqual([
      { name: 'Morgan Lee', role: 'Lead instructor' },
      { name: 'Priya Shah', role: '' },
    ])
    expect(parseStaff('Sam Ortiz, Bootcamp leader')).toEqual([
      { name: 'Sam Ortiz', role: 'Bootcamp leader' },
    ])
  })

  it('reads tab lines and comma lines mixed in one paste', () => {
    expect(
      parseStaff('Morgan Lee\tLead instructor\nPriya Shah, Case manager\nSam Ortiz').map((r) => [
        r.name,
        r.role,
      ])
    ).toEqual([
      ['Morgan Lee', 'Lead instructor'],
      ['Priya Shah', 'Case manager'],
      ['Sam Ortiz', ''],
    ])
  })

  it('reads quoted cells: commas, doubled quotes and line breaks inside quotes', () => {
    expect(
      parseStaff('"Lee, Morgan","Lead ""senior"" instructor"\n"Shah\nPriya",Case manager')
    ).toEqual([
      { name: 'Lee, Morgan', role: 'Lead "senior" instructor' },
      { name: 'Shah Priya', role: 'Case manager' },
    ])
  })

  it('takes Windows line endings, trailing tabs and a byte-order mark', () => {
    const paste = readStaffPaste('\uFEFFMorgan Lee\tLead instructor\t\t\r\nPriya Shah\t\r\n')
    expect(paste.rows).toEqual([
      { name: 'Morgan Lee', role: 'Lead instructor' },
      { name: 'Priya Shah', role: '' },
    ])
    expect(paste.ignored).toEqual([])
    expect(leftOutWords(paste)).toBeNull()
  })

  it('uses the headings to find each column, in either order and common spellings', () => {
    expect(parseStaff('Position\tEmployee Name\nCase manager\tPriya Shah')).toEqual([
      { name: 'Priya Shah', role: 'Case manager' },
    ])
    expect(parseStaff('Title,Full name\nBootcamp leader,Sam Ortiz')).toEqual([
      { name: 'Sam Ortiz', role: 'Bootcamp leader' },
    ])
  })

  it('never keeps an employee number: its column is listed as not used', () => {
    const paste = readStaffPaste('Emp #\tName\tTitle\n1041\tMorgan Lee\tLead instructor')
    expect(paste.rows).toEqual([{ name: 'Morgan Lee', role: 'Lead instructor' }])
    expect(paste.rows[0]).not.toHaveProperty('employeeNumber')
    expect(leftOutWords(paste)).toBe('Column not used: Emp #.')
    expect(leftOutWords(readStaffPaste('Employee ID,Name\n1041,Morgan Lee'))).toBe(
      'Column not used: Employee ID.'
    )
  })

  it('lists the rows with no name and the columns not used, in one line', () => {
    const paste = readStaffPaste(
      'Name,Employee number,Department,Role\nMorgan Lee,1041,Youth,Lead instructor\n,1052,Youth,\n\nSam Ortiz,1003,Adult,Director'
    )
    expect(paste.rows).toEqual([
      { name: 'Morgan Lee', role: 'Lead instructor' },
      { name: 'Sam Ortiz', role: 'Director' },
    ])
    expect(paste.skipped).toEqual([3])
    expect(paste.ignored).toEqual(['Employee number', 'Department'])
    expect(leftOutWords(paste)).toBe(
      'Skipped row 3: no name. Columns not used: Employee number, Department.'
    )
    expect(leftOutWords(readStaffPaste('Morgan Lee,Lead,Youth'))).toBe('Column not used: column 3.')
  })

  it('says every problem it can see at once, each on its row', () => {
    const list = [{ id: 's1', name: 'Morgan Lee' }]
    const problems = checkStaff(
      [
        { name: 'morgan  lee' },
        { name: 'Jordan Reyes', role: 'Instructor' },
        { name: 'JORDAN REYES', role: 'x'.repeat(81) },
        { name: '' },
      ],
      list
    )
    expect(problems).toEqual([
      {
        row: 1,
        field: 'name',
        message:
          'Already on the staff list: add something to tell them apart, e.g. morgan lee (their engagement)',
      },
      {
        row: 3,
        field: 'name',
        message: `Also on row 2: add something to tell them apart, e.g. JORDAN REYES (${'x'.repeat(81)})`,
      },
      { row: 3, field: 'role', message: 'The role is over 80 characters' },
      { row: 4, field: 'name', message: 'The name is missing' },
    ])
    // Told apart, they are fine.
    expect(checkStaff([{ name: 'Morgan Lee (Adult IT)' }], list)).toEqual([])
  })

  it("keeps a person's own name when they are edited", () => {
    const list = [{ id: 's1', name: 'Morgan Lee' }]
    expect(checkStaff([{ name: 'Morgan Lee', role: 'Lead' }], list, 's1')).toEqual([])
  })

  it("drops the server's row number beside the row", () => {
    expect(besideField({ row: 2, field: 'name', message: 'Row 2: the name is missing' })).toBe(
      'The name is missing'
    )
  })
})
