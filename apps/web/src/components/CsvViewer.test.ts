import { describe, expect, it } from 'vitest'
import { csvRows } from '@/components/CsvViewer'

describe('csvRows', () => {
  it('keeps quoted commas and doubled quotes, and leaves out blank lines', () => {
    const text = '﻿Payroll report\r\n\r\nName,Pay\r\n"Rivera, Alex","1,200.00"\n"Says ""hi""",5\n'
    expect(csvRows(text)).toEqual([
      ['Payroll report'],
      ['Name', 'Pay'],
      ['Rivera, Alex', '1,200.00'],
      ['Says "hi"', '5'],
    ])
  })
})
