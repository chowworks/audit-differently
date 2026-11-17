import { describe, expect, it } from 'vitest'
import type { InboundReceiptDto } from '@ad/types'
import { moveOptions, whereFiled } from './ReceiptsInbox'

const PDF = 'application/pdf'
const CSV = 'text/csv'

describe("the emailed documents inbox's Move to… (owner's decision, 2026-11-17)", () => {
  it('offers every other folder that takes the file, a receipt to Pay stubs included', () => {
    const opts = moveOptions({ kind: 'receipt', contentType: PDF, personal: false })
    expect(opts).not.toContain('receipt')
    expect(opts).toContain('paystub')
  })

  it('keeps a personal file personal and a file to the folders that take its type', () => {
    expect(moveOptions({ kind: 'paystub', contentType: PDF, personal: true })).toEqual([
      'payroll-details',
    ])
    expect(moveOptions({ kind: 'timesheet', contentType: CSV, personal: false })).not.toContain(
      'receipt'
    )
  })
})

describe('whereFiled', () => {
  const row = (over: Partial<InboundReceiptDto>): InboundReceiptDto => ({
    id: 'in-1',
    status: 'filed',
    receivedAt: '2026-10-05T00:00:00Z',
    fromAddress: null,
    subject: null,
    engagementId: null,
    engagementName: null,
    documentCount: 2,
    kind: 'receipt',
    period: '2026-10',
    reason: null,
    error: null,
    attempts: 1,
    ...over,
  })

  it("says a receipt filed to no engagement is in Month End Close's Receipts", () => {
    expect(whereFiled(row({}))).toBe('2 files in Receipts, October 2026; an owner matches them')
  })

  it("names a receipt's engagement", () => {
    expect(whereFiled(row({ engagementId: 'e-1', engagementName: 'Youth Coding Program' }))).toBe(
      '2 files in Youth Coding Program'
    )
  })
})
