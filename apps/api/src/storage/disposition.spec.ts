import { disposition } from './r2-storage'

describe('disposition', () => {
  it('keeps the original file name for an inline link', () => {
    expect(disposition('inline', 'receipt.pdf')).toBe(
      `inline; filename="receipt.pdf"; filename*=UTF-8''receipt.pdf`
    )
  })
  it('forces a download when asked', () => {
    expect(disposition('attachment', 'Invoice 7.pdf')).toContain(
      'attachment; filename="Invoice 7.pdf"'
    )
  })
  it('keeps accents in the UTF-8 form and a plain fallback', () => {
    const d = disposition('inline', 'Reçu août.pdf')
    expect(d).toContain('filename="Re_u ao_t.pdf"')
    expect(d).toContain("filename*=UTF-8''Re%C3%A7u%20ao%C3%BBt.pdf")
  })
  it('drops quotes, slashes and line breaks so the header cannot be broken', () => {
    const d = disposition('inline', 'a"b/c\\d\r\ne.pdf')
    expect(d).toBe(`inline; filename="abcde.pdf"; filename*=UTF-8''abcde.pdf`)
  })
})
