import { unzipSync, strFromU8 } from 'fflate'

/** One sheet of a workbook as the viewer shows it: each row's cell text, and the rows and cells filled yellow. */
export interface SheetView {
  name: string
  /** rows[r][c], 0-based, as the sheet places them; a cell left out is ''. */
  rows: string[][]
  /** "r:c" (0-based) of each cell the file fills with a colour: the copy's highlights. */
  filled: Set<string>
  /** "r:c" of each bold cell. */
  bold: Set<string>
}

export interface WorkbookView {
  sheets: SheetView[]
  /** The sheet the workbook opens at. */
  active: number
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

/** The text of every <t> inside (a rich string's runs joined). */
const texts = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join('')

/** "C12" → [11, 2] */
const position = (ref: string): [number, number] => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!
  let col = 0
  for (const ch of m[1]!) col = col * 26 + ch.charCodeAt(0) - 64
  return [Number(m[2]) - 1, col - 1]
}

/** The built-in number formats that are dates (ECMA-376 18.8.30). */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
const isDateCode = (code: string) =>
  /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^general$/i.test(code)

/** An Excel date serial (1900 system) as MM/DD/YYYY, as the books' exports show it. */
export const serialDate = (n: number) => {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000))
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`
}

/** What each style (cellXfs index) means for the viewer: a date, a fill, bold. */
function readStyles(xml: string | undefined) {
  const out: { date: boolean; filled: boolean; bold: boolean }[] = []
  if (!xml) return out
  const custom = new Map<number, string>()
  for (const m of xml.matchAll(/<numFmt\s[^>]*>/g))
    custom.set(Number(attr(m[0], 'numFmtId')), decode(attr(m[0], 'formatCode') ?? ''))
  const fills = [
    ...(/<fills[^>]*>([\s\S]*?)<\/fills>/.exec(xml)?.[1] ?? '').matchAll(
      /<fill>([\s\S]*?)<\/fill>|<fill\/>/g
    ),
  ].map((m) => /patternType="solid"/.test(m[1] ?? ''))
  const fonts = [
    ...(/<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(xml)?.[1] ?? '').matchAll(
      /<font>([\s\S]*?)<\/font>|<font\/>/g
    ),
  ].map((m) => /<b\s*\/>|<b\s+val="(1|true)"/.test(m[1] ?? ''))
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  for (const m of xfs.matchAll(/<xf\s[^>]*?(?:\/>|>)/g)) {
    const fmt = Number(attr(m[0], 'numFmtId') ?? 0)
    out.push({
      date: DATE_FORMATS.has(fmt) || isDateCode(custom.get(fmt) ?? ''),
      filled: fills[Number(attr(m[0], 'fillId') ?? 0)] ?? false,
      bold: fonts[Number(attr(m[0], 'fontId') ?? 0)] ?? false,
    })
  }
  return out
}

/** A sheet's cells, by the shared strings and styles of its workbook. */
function readSheet(
  name: string,
  xml: string,
  shared: string[],
  styles: ReturnType<typeof readStyles>
): SheetView {
  const rows: string[][] = []
  const filled = new Set<string>()
  const bold = new Set<string>()
  const data = /<sheetData[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? ''
  let rowNo = -1
  for (const rm of data.matchAll(/<row(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rAttr = rm[1] ? attr(rm[1], 'r') : undefined
    rowNo = rAttr ? Number(rAttr) - 1 : rowNo + 1
    let colNo = -1
    for (const cm of (rm[2] ?? '').matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cm[1] ?? ''
      const ref = attr(head, 'r')
      const [r, c] = ref ? position(ref) : [rowNo, colNo + 1]
      colNo = c
      const style = styles[Number(attr(head, 's') ?? 0)]
      const type = attr(head, 't')
      const body = cm[2] ?? ''
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let text = ''
      if (type === 's') text = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') text = texts(body)
      else if (type === 'b') text = v === '1' ? 'TRUE' : v === undefined ? '' : 'FALSE'
      else if (v !== undefined) {
        const n = Number(v)
        text = type !== 'str' && style?.date && Number.isFinite(n) ? serialDate(n) : decode(v)
      }
      const row = (rows[r] ??= [])
      row[c] = text
      if (style?.filled) filled.add(`${r}:${c}`)
      if (style?.bold) bold.add(`${r}:${c}`)
    }
  }
  const width = Math.max(0, ...Array.from(rows, (r) => r?.length ?? 0))
  return {
    name,
    rows: Array.from(rows, (r) => Array.from({ length: width }, (_, j) => r?.[j] ?? '')),
    filled,
    bold,
  }
}

/** Resolves a relationship target ("worksheets/sheet1.xml" or "/xl/worksheets/sheet1.xml") inside the zip. */
const inXl = (target: string) => (target.startsWith('/') ? target.slice(1) : `xl/${target}`)

/** An xlsx file's sheets, in the workbook's order, read in the browser: nothing is sent anywhere. */
export function readWorkbook(bytes: Uint8Array): WorkbookView {
  const files = unzipSync(bytes)
  const text = (path: string) => (files[path] ? strFromU8(files[path]!) : undefined)
  const book = text('xl/workbook.xml')
  if (!book) throw new Error('This is not a spreadsheet')
  const rels = new Map<string, string>()
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\s[^>]*>/g))
    rels.set(attr(m[0], 'Id') ?? '', attr(m[0], 'Target') ?? '')
  const shared = [
    ...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g),
  ].map((m) => texts(m[1] ?? ''))
  const styles = readStyles(text('xl/styles.xml'))
  const sheets: SheetView[] = []
  for (const m of book.matchAll(/<sheet\s[^>]*>/g)) {
    if (/state="(hidden|veryHidden)"/.test(m[0])) continue
    const target = rels.get(attr(m[0], 'r:id') ?? '')
    const xml = target && text(inXl(target))
    if (xml) sheets.push(readSheet(decode(attr(m[0], 'name') ?? ''), xml, shared, styles))
  }
  const active = Number(/<workbookView\s[^>]*activeTab="(\d+)"/.exec(book)?.[1] ?? 0)
  return { sheets, active: active < sheets.length ? active : 0 }
}
