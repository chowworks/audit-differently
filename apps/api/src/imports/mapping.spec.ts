import Anthropic from '@anthropic-ai/sdk'
import { Logger } from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aiGuessColumns } from './ai-guess'
import {
  amountOf,
  cleanCategories,
  cleanColumns,
  cleanLines,
  matchItem,
  dateOf,
  fingerprintOf,
  fingerprintsOf,
  guessColumns,
  transactionsOf,
} from './mapping'

/** The SDK's client, with its messages.create replaced: no request ever leaves a test. */
const mockCreate = jest.fn()
const mockOptions: unknown[] = []
jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk')
  class Mocked extends actual.default {
    constructor(options: object) {
      super(options)
      mockOptions.push(options)
      ;(this as unknown as { messages: unknown }).messages = {
        create: (...a: unknown[]) => mockCreate(...a),
      }
    }
  }
  return { ...actual, __esModule: true, default: Mocked }
})
const answer = (text: string, stop_reason = 'end_turn') => ({
  stop_reason,
  content: [{ type: 'text', text }],
})
import { readTable, tableOf } from './table'

const SAMPLE = readFileSync(join(__dirname, '../../test/fixtures/sample-qb-export.csv'))

describe('guessColumns', () => {
  it("maps a QuickBooks transaction report by its column names, Split as the category, and flips a register's signs", async () => {
    const t = await readTable(SAMPLE, 'sample-qb-export.csv')
    expect(guessColumns(t)).toEqual({
      date: 'Date',
      vendor: 'Name',
      memo: 'Memo/Description',
      amount: 'Amount',
      reference: 'Num',
      account: 'Account',
      category: 'Split',
      flipSign: true,
    })
  })

  it('takes the money-out column as the total cost when there is no amount, and leaves money in out', () => {
    const t = tableOf([
      ['Posting Date', 'Payee', 'Debit', 'Credit', 'Category', 'Notes'],
      ['2026-07-01', 'X', '10.00', '', 'Travel', 'n'],
    ])
    expect(guessColumns(t)).toEqual({
      date: 'Posting Date',
      vendor: 'Payee',
      amount: 'Debit',
      category: 'Category',
      flipSign: false,
    })
  })
})

describe('cleanColumns and cleanCategories', () => {
  const headers = ['Date', 'Name', 'Amount', 'Split']

  it('keeps a mapping that names columns of the file, with a date, a payee and an amount', () => {
    expect(
      cleanColumns(
        { date: 'Date', vendor: 'Name', amount: 'Amount', category: 'Split', flipSign: true, x: 1 },
        headers
      )
    ).toEqual({ date: 'Date', vendor: 'Name', amount: 'Amount', category: 'Split', flipSign: true })
  })

  it('refuses a column the file does not have, and a mapping without the fields a line needs', () => {
    expect(() => cleanColumns({ date: 'When', vendor: 'Name', amount: 'Amount' }, headers)).toThrow(
      /no column "When"/
    )
    expect(() => cleanColumns({ vendor: 'Name', amount: 'Amount' }, headers)).toThrow(/date/)
    expect(() => cleanColumns({ date: 'Date', amount: 'Amount' }, headers)).toThrow(/payee/)
    expect(() => cleanColumns({ date: 'Date', vendor: 'Name' }, headers)).toThrow(/amount/)
    expect(() => cleanColumns(null, headers)).toThrow(/date/)
  })

  it('names every problem in one answer, not one refusal at a time', () => {
    expect(() => cleanColumns({ date: 'When', vendor: 'Payee', memo: 'Notes' }, headers)).toThrow(
      /no column "When".*no column "Payee".*no column "Notes".*amount/
    )
  })

  it('maps categories to the budget items offered, or to skip, and nothing else', () => {
    const keys = new Set(['supplies', 'travel'])
    expect(
      cleanCategories({ 'Office Supplies': 'supplies', Meals: 'skip', Rent: '' }, keys)
    ).toEqual({ 'Office Supplies': 'supplies', Meals: 'skip' })
    expect(() => cleanCategories({ Rent: 'personnel' }, keys)).toThrow(/does not use/)
    expect(cleanCategories(['x'], keys)).toEqual({})
  })
})

describe('reading a cell', () => {
  it('reads amounts as accounting exports write them', () => {
    expect(amountOf('$1,234.50')).toBe(1234.5)
    expect(amountOf('-1,250.00')).toBe(-1250)
    expect(amountOf('(12.00)')).toBe(-12)
    expect(amountOf('-$7,160.28')).toBe(-7160.28)
    expect(amountOf('')).toBeNull()
    expect(amountOf('n/a')).toBeNull()
    expect(amountOf('.5')).toBe(0.5)
    expect(amountOf('$')).toBeNull()
  })

  it('never guesses at an amount written another way: a comma after the dot, a stray comma, three decimals', () => {
    expect(amountOf('1.234,50')).toBeNull()
    expect(amountOf('12,5')).toBeNull()
    expect(amountOf('1.234')).toBeNull()
    expect(amountOf('1 234,50')).toBeNull()
    expect(amountOf('1,234,567.8')).toBe(1234567.8)
  })

  it('marks a row whose amount cell holds something unreadable, and not one left blank', () => {
    const t = tableOf([
      ['Date', 'Payee', 'Amount'],
      ['07/01/2026', 'X', '1.234,50'],
      ['07/02/2026', 'X', ''],
      ['07/03/2026', 'X', '5.00'],
    ])
    expect(
      transactionsOf(t, { date: 'Date', vendor: 'Payee', amount: 'Amount' }).map(
        (r) => r.amountUnreadable
      )
    ).toEqual([true, false, false])
  })

  it('reads ISO and US dates, and refuses a date that does not exist', () => {
    expect(dateOf('2026-07-15')).toBe('2026-07-15')
    expect(dateOf('07/15/2026')).toBe('2026-07-15')
    expect(dateOf('7/5/26')).toBe('2026-07-05')
    expect(dateOf('02/30/2026')).toBeNull()
    expect(dateOf('July 15')).toBeNull()
  })
})

describe('transactionsOf', () => {
  it('reads each row through the mapping: debit less credit, signs flipped when asked, item numbers ID-like', () => {
    const t = tableOf([
      ['Date', 'Payee', 'Debit', 'Credit', 'Ref', 'GL'],
      ['07/01/2026', 'Bright Path Office Supply', '10.00', '', 'A:1', 'Supplies:Paper'],
      ['07/02/2026', 'Lakeside Transit Co.', '', '4.00', '', ''],
      ['07/03/2026', 'X', '', '', '', ''],
    ])
    const rows = transactionsOf(t, {
      date: 'Date',
      vendor: 'Payee',
      debit: 'Debit',
      credit: 'Credit',
      reference: 'Ref',
      account: 'GL',
    })
    expect(rows.map((r) => [r.date, r.amount, r.reference, r.account, r.category])).toEqual([
      ['2026-07-01', 10, 'A 1', 'Supplies Paper', 'Supplies:Paper'],
      ['2026-07-02', -4, null, null, ''],
      ['2026-07-03', null, null, null, ''],
    ])
    const flipped = transactionsOf(t, {
      date: 'Date',
      vendor: 'Payee',
      debit: 'Debit',
      flipSign: true,
    })
    expect(flipped[0].amount).toBe(-10)
  })

  it('fingerprints a row by its date, amount, payee, memo, reference, account and category, whatever the spacing and case', () => {
    const base = {
      line: 1,
      date: '2026-07-01',
      vendor: 'Bright Path',
      memo: 'Paper',
      amount: 10,
      amountUnreadable: false,
      reference: '1',
      account: 'Checking',
      category: 'Supplies',
    }
    expect(
      fingerprintOf({ ...base, vendor: ' bright  path ', line: 9, category: 'SUPPLIES' })
    ).toBe(fingerprintOf(base))
    expect(fingerprintOf({ ...base, amount: 10.01 })).not.toBe(fingerprintOf(base))
    expect(fingerprintOf({ ...base, reference: '2' })).not.toBe(fingerprintOf(base))
    // A split line: the same purchase, coded to two categories or paid from two accounts.
    expect(fingerprintOf({ ...base, category: 'Travel' })).not.toBe(fingerprintOf(base))
    expect(fingerprintOf({ ...base, account: 'Savings' })).not.toBe(fingerprintOf(base))
  })

  it('tells identical rows of one file apart by their order, the same way each time', () => {
    const row = {
      line: 1,
      date: '2026-07-01',
      vendor: 'X',
      memo: '',
      amount: 5,
      amountUnreadable: false,
      reference: null,
      account: null,
      category: '',
    }
    const other = { ...row, vendor: 'Y' }
    const prints = fingerprintsOf([row, other, { ...row, line: 3 }])
    expect(new Set(prints).size).toBe(3)
    expect(prints[0]).toBe(fingerprintOf(row))
    expect(prints[2]).toBe(fingerprintOf(row, 2))
    expect(fingerprintsOf([row, other, row])).toEqual(prints)
  })
})

describe('aiGuessColumns', () => {
  const headers = ['Date', 'Name', 'Amount']
  beforeEach(() => {
    mockCreate.mockReset()
    mockOptions.length = 0
  })

  it('asks nothing without ANTHROPIC_API_KEY', async () => {
    expect(await aiGuessColumns(headers, {})).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockOptions).toEqual([])
  })

  it('sends the column names alone through the SDK, and keeps only names the file has', async () => {
    mockCreate.mockResolvedValue(answer('{"date":"Date","vendor":"Name","amount":"Total"}'))
    expect(await aiGuessColumns(headers, { ANTHROPIC_API_KEY: 'test' })).toEqual({
      date: 'Date',
      vendor: 'Name',
    })
    expect(mockOptions).toEqual([{ apiKey: 'test', timeout: 15_000, maxRetries: 1 }])
    const [body] = mockCreate.mock.calls[0] as [Record<string, unknown>]
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' } })
    const messages = body.messages as { content: string }[]
    expect(messages[0]!.content).toContain('["Date","Name","Amount"]')
  })

  it('answers null on any failure, so the guess from the names stands, and never logs the key', async () => {
    const env = { ANTHROPIC_API_KEY: 'sk-test-secret' }
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const failures = [
      new Anthropic.APIError(529, undefined, 'overloaded', new Headers()),
      new Anthropic.APIConnectionTimeoutError(),
      new Error('offline'),
    ]
    for (const f of failures) {
      mockCreate.mockRejectedValueOnce(f)
      expect(await aiGuessColumns(headers, env)).toBeNull()
    }
    mockCreate.mockResolvedValueOnce(answer('no idea'))
    expect(await aiGuessColumns(headers, env)).toBeNull()
    // Cut short: even a good-looking answer is not used.
    mockCreate.mockResolvedValueOnce(answer('{"date":"Date","vendor":"Name"}', 'max_tokens'))
    expect(await aiGuessColumns(headers, env)).toBeNull()
    mockCreate.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] })
    expect(await aiGuessColumns(headers, env)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(6)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-test-secret')
    expect(String(warn.mock.calls[0]![0])).toContain('answered 529')
    expect(String(warn.mock.calls[1]![0])).toContain('in time')
    warn.mockRestore()
  })
})

describe('matchItem and cleanLines', () => {
  const items = [
    { key: 'supplies', label: 'Supplies' },
    { key: 'travel', label: 'Travel' },
    { key: 'contractual', label: 'Contractual / Subawards' },
  ]

  it('matches a value to the one budget item it names, ignoring case, spaces and a plural', () => {
    expect(matchItem('supply', items)).toBe('supplies')
    expect(matchItem('TRAVEL', items)).toBe('travel')
    expect(matchItem('Contractual/Subawards', items)).toBe('contractual')
    expect(matchItem('Office rent', items)).toBeNull()
    expect(matchItem('', items)).toBeNull()
  })

  it('keeps per-row budget lines by line number, refusing an item the engagement does not use', () => {
    const keys = new Set(['supplies'])
    expect(cleanLines({ '2': 'supplies', '3': 'skip', '4': '' }, keys)).toEqual({
      '2': 'supplies',
      '3': 'skip',
    })
    expect(() => cleanLines({ '2': 'rent' }, keys)).toThrow(/does not use/)
    expect(() => cleanLines({ abc: 'supplies' }, keys)).toThrow(/line number/)
  })
})
