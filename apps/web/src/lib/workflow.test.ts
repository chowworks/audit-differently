import { describe, expect, it } from 'vitest'
import type { DocumentDto } from '@ad/types'
import { signedCopyOf } from './workflow'

const signed = (id: string, uploadedAt: string, period = '2026-09'): DocumentDto => ({
  id,
  kind: 'signed-report',
  sensitivity: 'financial',
  fileName: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 1,
  period,
  uploadedAt,
})

describe('signedCopyOf', () => {
  const submitted = signed('d-submitted', '2026-10-07T00:00:00.000Z')
  const corrected = signed('d-corrected', '2026-10-10T00:00:00.000Z')
  const october = signed('d-oct', '2026-11-02T00:00:00.000Z', '2026-10')

  it("counts the month's newest signed copy when it was never reopened", () => {
    expect(signedCopyOf([submitted, october], '2026-09')).toBe(submitted)
    expect(signedCopyOf([submitted, corrected], '2026-09', null)).toBe(corrected)
  })

  it('counts only a copy uploaded after the latest reopening', () => {
    expect(signedCopyOf([submitted], '2026-09', '2026-10-09T00:00:00.000Z')).toBeUndefined()
    expect(signedCopyOf([submitted, corrected], '2026-09', '2026-10-09T00:00:00.000Z')).toBe(
      corrected
    )
  })
})
