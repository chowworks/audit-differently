import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentTermsVersion, findTermsFile, termsFingerprint } from './terms-fingerprint'

const page = (inner: string) =>
  `<main><section id="terms">${inner}</section><section id="contact">x</section></main>`

describe('termsFingerprint', () => {
  const compact = page('<h2>1. Who</h2><p>You agree &amp; accept this, fully.</p>')

  it('is 16 hex characters', () => {
    expect(termsFingerprint(compact)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is the same after prettier re-wraps the lines', () => {
    const wrapped = page(
      '\n  <h2>1. Who</h2>\n  <p>\n    You agree &amp;\n    accept this,\n    fully.\n  </p>\n'
    )
    expect(termsFingerprint(wrapped)).toBe(termsFingerprint(compact))
  })

  it('is the same when an entity is written another way', () => {
    const numeric = page('<h2>1. Who</h2><p>You agree &#38; accept this, fully.</p>')
    const raw = page('<h2>1. Who</h2><p>You agree & accept this, fully.</p>')
    expect(termsFingerprint(numeric)).toBe(termsFingerprint(compact))
    expect(termsFingerprint(raw)).toBe(termsFingerprint(compact))
  })

  it('ignores everything outside the terms section', () => {
    expect(termsFingerprint(compact.replace('>x<', '>something else<'))).toBe(
      termsFingerprint(compact)
    )
  })

  it('changes when a word changes', () => {
    expect(termsFingerprint(compact.replace('accept', 'refuse'))).not.toBe(
      termsFingerprint(compact)
    )
  })

  it('throws when there is no terms section', () => {
    expect(() => termsFingerprint('<main></main>')).toThrow(/no <section id="terms">/)
  })
})

describe('the Terms page on disk', () => {
  it('is found from where this code runs, and has a version', () => {
    expect(findTermsFile()).toMatch(/docs[\\/]terms[\\/]index\.html$/)
    expect(currentTermsVersion()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is found from a deployed layout (dist under apps/api, docs beside apps)', () => {
    const root = mkdtempSync(join(tmpdir(), 'terms-'))
    mkdirSync(join(root, 'docs', 'terms'), { recursive: true })
    mkdirSync(join(root, 'apps', 'api', 'dist', 'auth'), { recursive: true })
    writeFileSync(join(root, 'docs', 'terms', 'index.html'), page('<p>Hi</p>'))
    expect(findTermsFile(join(root, 'apps', 'api', 'dist', 'auth'))).toBe(
      join(root, 'docs', 'terms', 'index.html')
    )
  })
})
