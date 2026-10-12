import { looksLike } from './documents.service'

describe('looksLike', () => {
  it('accepts each allowed type by its first bytes', () => {
    expect(looksLike(Buffer.from('%PDF-1.7 ...'), 'application/pdf')).toBe(true)
    expect(
      looksLike(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), 'image/png')
    ).toBe(true)
    expect(looksLike(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg')).toBe(true)
    expect(
      looksLike(
        Buffer.from('PK\x03\x04rest'),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
    ).toBe(true)
  })

  it('refuses bytes that are not the claimed type, and unknown types', () => {
    expect(looksLike(Buffer.from('<html><script>'), 'application/pdf')).toBe(false)
    expect(looksLike(Buffer.from('%PDF-1.7'), 'image/png')).toBe(false)
    expect(looksLike(Buffer.from(''), 'application/pdf')).toBe(false)
    expect(looksLike(Buffer.from('%PDF-'), 'text/html')).toBe(false)
  })
})
