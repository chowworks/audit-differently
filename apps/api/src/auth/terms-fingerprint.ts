import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The version of the Terms is the fingerprint of their wording: the text inside <section id="terms"> of
 * docs/terms/index.html with tags and entities resolved and whitespace collapsed (so prettier re-wrapping or
 * writing an entity differently changes nothing), hashed, first 16 hex characters. Change a word and everyone
 * is asked to accept again; nobody has to remember to bump anything.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  mdash: '—',
  ndash: '–',
  hellip: '…',
}

const SECTION = /<section id="terms">([\s\S]*?)<\/section>/

/** The Terms' text in a normal form, or null when the page has no #terms section. */
export function termsWording(html: string): string | null {
  const section = SECTION.exec(html)
  if (!section) return null
  return section[1]!
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?)])/g, '$1')
    .trim()
}

/** The version of the Terms in this page; throws when the page has no #terms section. */
export function termsFingerprint(html: string): string {
  const wording = termsWording(html)
  if (!wording) throw new Error('The Terms page has no <section id="terms">')
  return createHash('sha256').update(wording).digest('hex').slice(0, 16)
}

/**
 * docs/terms/index.html, found by walking up from this file: the repository root is the build and run root
 * (nixpacks.toml, .railway/railway.ts), so docs/ sits next to apps/ from src/auth under ts-jest and from dist/auth
 * in the deployed container alike. Null when it is nowhere above.
 */
export function findTermsFile(from: string = __dirname): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'docs', 'terms', 'index.html')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return null
  }
}

/** The version of the Terms as the page on disk now says. Throws when the page or its #terms section is missing. */
export function currentTermsVersion(path: string | null = findTermsFile()): string {
  if (!path) throw new Error('docs/terms/index.html was not found')
  return termsFingerprint(readFileSync(path, 'utf8'))
}
