import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { strToU8 } from 'fflate'
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib'
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_PURPOSE_LABELS,
  DOCUMENT_PURPOSES,
  DOCUMENT_SENSITIVITY,
  REPORT_LINE_LABELS,
  REPORT_STATUS_LABELS,
  type DocumentKind,
  type DocumentPurpose,
  type ReportLine,
  type ReportStatus,
  type StatementMark,
} from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { staffName, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { howMany, monthName } from '../core/changes'
import { keyInWorkspace } from '../documents/documents.service'
import { csv, day, ext, money, safe } from '../engagements/audit-package.service'
import { zipEntries, type ZipSource } from '../engagements/zip-stream'
import { itemCopy, markPlace, NOT_DRAWN } from '../payroll/mark-pdf'
import { PrismaService } from '../prisma/prisma.service'
import {
  currentSignedCopy,
  earlierSignedName,
  reopenedWords,
  reopeningRows,
  type Reopening,
} from './reopenings'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'

/**
 * Bundle.pdf is made in memory (pdf-lib holds every page it copies), so the records that go into it are capped. A
 * month over the cap is refused with a message; the audit package, which streams, still holds it. A PNG counts at
 * its decoded size (pdf-lib decodes it to 4 bytes a pixel); a PDF or a JPEG at its file size, since pdf-lib copies
 * a JPEG into the PDF as it is.
 */
export const MAX_BUNDLE_PDF_BYTES = 100 * 1024 * 1024

/** Bundles made at once in this process at most, since each holds its PDF in memory; others wait their turn. */
export const MAX_BUNDLES_AT_ONCE = 2
/** How long a download waits for a turn before it is told to try again. */
const BUNDLE_WAIT_MS = 15_000

/** At most `max` pieces of work at once; one more waits up to `waitMs` for a turn, then is answered 503. */
export class BuildGate {
  private running = 0
  private readonly queue: (() => void)[] = []

  constructor(
    private readonly max: number,
    private readonly waitMs: number
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.enter()
    try {
      return await work()
    } finally {
      this.leave()
    }
  }

  private enter(): Promise<void> {
    if (this.running < this.max) {
      this.running++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.queue.splice(this.queue.indexOf(turn), 1)
        reject(
          new ServiceUnavailableException(
            'Other bundles are being made right now. Try again in a minute.'
          )
        )
      }, this.waitMs)
      this.queue.push(turn)
    })
  }

  /** The turn passes straight to the next one waiting, if any. */
  private leave() {
    const next = this.queue.shift()
    if (next) next()
    else this.running--
  }
}
const bundles = new BuildGate(MAX_BUNDLES_AT_ONCE, BUNDLE_WAIT_MS)

/** A PNG's size once decoded (width by height by 4 bytes), from its header; null when the header is not a PNG's. */
export const pngDecodedBytes = (b: Uint8Array): number | null => {
  if (b.length < 24 || String.fromCharCode(...b.subarray(12, 16)) !== 'IHDR') return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return v.getUint32(16) * v.getUint32(20) * 4
}

const tooBig = (bytes: number) =>
  new PayloadTooLargeException(
    `This month's records come to ${Math.ceil(bytes / 1024 / 1024)} MB, more than the ${MAX_BUNDLE_PDF_BYTES / 1024 / 1024} MB one bundle holds. Download the audit package from the engagement page instead.`
  )

/** The month's payroll proof, filed once after the ledger's own records. */
const PAYROLL_PROOF = new Set(['bank-statement', 'payroll-register'])
/** What goes into Bundle.pdf; anything else (xlsx, docx) goes in Supporting files/ as uploaded. */
const IN_PDF = new Set(['application/pdf', 'image/png', 'image/jpeg'])

type Doc = {
  id: string
  storageKey: string
  fileName: string
  kind: string
  contentType: string
  size: number
  sha256: string
  uploadedAt: Date
  workspaceId: string
  engagementId: string | null
  period: string | null
  sensitivity: string
}

/** One item a record supports: a ledger line, a work-experience payment, or the month's payroll. */
interface Support {
  item: string
  who: string
  purpose: string
  amount: number | null
}

interface Section {
  part: 'signed' | 'ledger' | 'payroll'
  doc: Doc
  supports: Support[]
  marks: StatementMark[]
  /** The marks that could not be drawn on the bundle's copy (all of them when the file is not in Bundle.pdf). */
  notDrawn: StatementMark[]
}

export interface MonthBundle {
  /** The zip's file name: `<engagement> - <Month YYYY> - bundle.zip`. */
  name: string
  workspaceId: string
  reportId: string
  /** The stored records in the bundle (in Bundle.pdf or in Supporting files/). */
  files: number
  description: string
  entries: [string, ZipSource][]
}

/** A link's highlights: its exact-word marks, or the one line marked before they were kept. */
const marksOf = (link: { mark?: unknown; marks?: unknown }): StatementMark[] =>
  Array.isArray(link.marks) && link.marks.length
    ? (link.marks as StatementMark[])
    : link.mark
      ? [link.mark as StatementMark]
      : []

const isPersonal = (d: Doc) =>
  d.sensitivity === 'personal' || DOCUMENT_SENSITIVITY[d.kind as DocumentKind] === 'personal'
const kindLabel = (k: string) => DOCUMENT_KIND_LABELS[k as DocumentKind] ?? k
const purposeLabel = (p: string) => DOCUMENT_PURPOSE_LABELS[p as DocumentPurpose] ?? p
const purposeOrder = (p: string) => {
  const i = (DOCUMENT_PURPOSES as readonly string[]).indexOf(p)
  return i < 0 ? DOCUMENT_PURPOSES.length : i
}
const lineLabel = (l: string) => REPORT_LINE_LABELS[l as ReportLine] ?? l

// ── PDF text ──────────────────────────────────────────────────────────────────

/** Text the standard PDF fonts can draw (WinAnsi): common punctuation made plain, anything else a question mark. */
const ansi = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')

/** The text cut to `width` points, with an ellipsis when it was cut. */
const fit = (text: string, font: PDFFont, size: number, width: number) => {
  let t = ansi(text)
  if (font.widthOfTextAtSize(t, size) <= width) return t
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1)
  return `${t}...`
}

const PAGE: [number, number] = [612, 792]
const MARGIN = 54

/** Writes lines down generated pages, starting a new page when one is full. */
class Pager {
  private page!: PDFPage
  private y = 0
  pages = 0

  constructor(
    private readonly pdf: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont
  ) {
    this.newPage()
  }

  private newPage() {
    this.page = this.pdf.addPage(PAGE)
    this.y = PAGE[1] - MARGIN
    this.pages++
  }

  /** Columns on one line: each at its x, cut to its width; `right` aligns the column's right edge to x. */
  row(
    cols: { text: string; x: number; width: number; right?: boolean }[],
    opts: { size?: number; bold?: boolean } = {}
  ) {
    const size = opts.size ?? 10
    const font = opts.bold ? this.bold : this.font
    if (this.y < MARGIN + size) this.newPage()
    for (const c of cols) {
      const t = fit(c.text, font, size, c.width)
      const x = c.right ? c.x - font.widthOfTextAtSize(t, size) : c.x
      this.page.drawText(t, { x, y: this.y, size, font })
    }
    this.y -= size * 1.5
  }

  line(text: string, opts: { size?: number; bold?: boolean } = {}) {
    this.row([{ text, x: MARGIN, width: PAGE[0] - 2 * MARGIN }], opts)
  }

  gap(points = 8) {
    this.y -= points
  }
}

/**
 * The month's bundle: what goes to the funding organization with the invoice, as one zip. Bundle.pdf holds the
 * signed monthly report (or a cover page saying it is not on file yet), a ledger summary, each ledger line's
 * supporting records in ledger order, then the payroll proof with each marked line highlighted. Records a PDF cannot
 * hold (xlsx, docx) are in Supporting files/, named by item. Index.csv lists every record and what it supports.
 * Personal records never go in, whatever the role: the funder did not ask for them by name. Any member of the
 * workspace may download it; there is no link to share.
 */
@Injectable()
export class MonthBundleService {
  private readonly logger = new Logger(MonthBundleService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage
  ) {}

  /**
   * Builds Bundle.pdf, the README and the index; the supporting files are fetched when the zip is streamed. At most
   * MAX_BUNDLES_AT_ONCE are built at once; a download that cannot get a turn soon is answered 503.
   */
  async make(caller: Caller, reportId: string): Promise<MonthBundle> {
    return bundles.run(() => this.build(caller, reportId))
  }

  private async build(caller: Caller, reportId: string): Promise<MonthBundle> {
    const r = await this.prisma.monthlyReport.findFirst({
      where: { id: reportId, ...tenantWhere(caller) },
      include: {
        engagement: { include: { workspace: true } },
        reopenings: { orderBy: { reopenedAt: 'asc' } },
        expenses: {
          orderBy: [{ date: 'asc' }, { itemNumber: 'asc' }],
          include: { documents: { include: { document: true } } },
        },
        wexPayments: {
          orderBy: { payPeriodStart: 'asc' },
          include: {
            participant: { select: { participantId: true } },
            documents: { include: { document: true } },
          },
        },
      },
    })
    if (!r || !r.workspaceId || !workspaceRole(caller, r.workspaceId)) throw new NotFoundException()
    const workspaceId = r.workspaceId
    const c = r.engagement
    const monthDocs: Doc[] = await this.prisma.document.findMany({
      where: { engagementId: r.engagementId, period: r.period, ...tenantWhere(caller) },
      orderBy: { uploadedAt: 'asc' },
    })
    const month = monthName(r.period)

    // Which record goes where, and what each one supports. A record behind several items is filed once, except a
    // payroll proof highlighted for its item: each item gets its own copy, with only its own highlights, so each copy
    // stands on its own (owner's decision, 2026-10-16).
    const personalLeftOut = new Set<string>()
    const sections = new Map<string, Section>()
    const filedDocs = new Set<string>()
    const file = (
      d: Doc,
      part: Section['part'],
      support?: Support,
      link?: { mark?: unknown; marks?: unknown; item: string }
    ) => {
      if (d.workspaceId !== workspaceId || !keyInWorkspace(d)) throw new NotFoundException()
      if (isPersonal(d)) {
        personalLeftOut.add(d.id)
        return
      }
      const placed = PAYROLL_PROOF.has(d.kind) && part === 'ledger' ? 'payroll' : part
      const own = link ? marksOf(link) : []
      const key = own.length && PAYROLL_PROOF.has(d.kind) ? `${d.id}#${link!.item}` : d.id
      const s = sections.get(key) ?? {
        part: placed,
        doc: d,
        supports: [],
        marks: [],
        notDrawn: [],
      }
      sections.set(key, s)
      filedDocs.add(d.id)
      if (support) s.supports.push(support)
      if (key !== d.id) s.marks.push(...own)
    }
    const lastReopenedAt = r.reopenings[r.reopenings.length - 1]?.reopenedAt
    const signed = currentSignedCopy(
      monthDocs.filter((d) => !isPersonal(d)),
      r.period,
      lastReopenedAt
    )
    if (signed)
      file(signed, 'signed', {
        item: 'Monthly report',
        who: '',
        purpose: 'Signed report',
        amount: null,
      })
    for (const e of r.expenses) {
      const amount = Number(e.allocatedAmount)
      const links = [...e.documents].sort(
        (a, b) => purposeOrder(a.purpose) - purposeOrder(b.purpose)
      )
      for (const ed of links)
        file(
          ed.document,
          'ledger',
          { item: e.itemNumber, who: e.vendor, purpose: purposeLabel(ed.purpose), amount },
          { mark: ed.mark, marks: ed.marks, item: `expense ${e.id}` }
        )
    }
    for (const w of r.wexPayments)
      for (const wd of w.documents)
        file(
          wd.document,
          'payroll',
          {
            item: `Work experience ${day(w.payPeriodStart)} to ${day(w.payPeriodEnd)}`,
            who: `participant ${w.participant.participantId}`,
            purpose: purposeLabel(wd.purpose),
            amount: Number(w.grossAmount),
          },
          { mark: wd.mark, marks: wd.marks, item: `wex ${w.id}` }
        )
    for (const d of monthDocs) {
      if (isPersonal(d)) personalLeftOut.add(d.id)
      else if (PAYROLL_PROOF.has(d.kind) && !filedDocs.has(d.id))
        file(d, 'payroll', {
          item: "The month's payroll",
          who: '',
          purpose: 'Not linked to an item',
          amount: null,
        })
    }
    const order = { signed: 0, ledger: 1, payroll: 2 }
    const ordered = [...sections.values()].sort((a, b) => order[a.part] - order[b.part])

    // File sizes first, before anything is read; a PNG then counts at its decoded size once its header is read.
    let inPdf = ordered
      .filter((s) => IN_PDF.has(s.doc.contentType))
      .reduce((t, s) => t + (s.doc.size ?? 0), 0)
    if (inPdf > MAX_BUNDLE_PDF_BYTES) throw tooBig(inPdf)

    // Bundle.pdf, in order.
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const pageNo = () => pdf.getPageCount() + 1
    const title = `${c.name}${c.number ? ` (${c.number})` : ''}`
    const root = safe(`${c.name} - ${month} - bundle`)
    const supporting: [string, string][] = []
    const seen = new Set<string>()
    const supportingPath = (s: Section) => {
      const first = s.supports[0]
      const base = s.doc.fileName.replace(/\.[^.]+$/, '')
      const name = safe(
        `${first?.item ?? 'Record'} - ${first?.purpose ?? kindLabel(s.doc.kind)} - ${base}`
      )
      let path = `Supporting files/${name}${ext(s.doc.fileName)}`
      for (let n = 2; seen.has(path); n++)
        path = `Supporting files/${name} (${n})${ext(s.doc.fileName)}`
      seen.add(path)
      supporting.push([path, s.doc.storageKey])
      return path
    }
    const where = new Map<string, string>()
    const index: (string | number)[][] = [
      [
        'Section',
        'Item',
        'Vendor or participant',
        'Purpose',
        'Amount',
        'Document type',
        'Original file',
        'In this bundle',
        'Uploaded',
        'SHA-256',
      ],
    ]
    const generated = (section: string, from: number, to: number) =>
      index.push([section, '', '', '', '', 'generated', '', pagesWords(from, to), '', ''])

    /** Adds a section's own pages when called (a PDF's pages copied, an image on a page); null when it cannot go in. */
    const content = async (s: Section): Promise<(() => void) | null> => {
      if (!IN_PDF.has(s.doc.contentType)) return null
      try {
        let bytes: Uint8Array = new Uint8Array(await this.storage.read(s.doc.storageKey))
        if (s.doc.contentType === 'image/png') {
          const decoded = pngDecodedBytes(bytes)
          if (decoded != null) inPdf += decoded - (s.doc.size ?? 0)
          if (inPdf > MAX_BUNDLE_PDF_BYTES) throw tooBig(inPdf)
        }
        if (s.doc.contentType !== 'application/pdf') {
          const image =
            s.doc.contentType === 'image/png'
              ? await pdf.embedPng(bytes)
              : await pdf.embedJpg(bytes)
          const scale = Math.min(
            1,
            (PAGE[0] - 2 * MARGIN) / image.width,
            (PAGE[1] - 2 * MARGIN) / image.height
          )
          const w = image.width * scale
          const h = image.height * scale
          return () =>
            pdf
              .addPage(PAGE)
              .drawImage(image, { x: (PAGE[0] - w) / 2, y: (PAGE[1] - h) / 2, width: w, height: h })
        }
        if (s.marks.length) {
          const marked = await itemCopy(bytes, s.marks)
          bytes = marked.bytes
          s.notDrawn = marked.notDrawn
        }
        const src = await PDFDocument.load(bytes, { updateMetadata: false })
        const pages = await pdf.copyPages(src, src.getPageIndices())
        return () => pages.forEach((pg) => pdf.addPage(pg))
      } catch (e) {
        if (e instanceof HttpException) throw e
        // A file pdf-lib cannot open (encrypted, damaged) goes in Supporting files/ as uploaded.
        this.logger.warn(`A record could not be added to the bundle's PDF: ${(e as Error).message}`)
        return null
      }
    }
    const header = (s: Section, path: string | null) => {
      const p = new Pager(pdf, font, bold)
      p.line(
        s.part === 'payroll'
          ? `Payroll proof: ${kindLabel(s.doc.kind)}`
          : `Supporting record for ${[...new Set(s.supports.map((x) => x.item))].join(', ')}`,
        { size: 14, bold: true }
      )
      p.line(`${title} - ${month}`, { size: 10 })
      p.gap()
      p.line(`${kindLabel(s.doc.kind)}: ${s.doc.fileName}`)
      p.gap()
      p.line('Supports', { bold: true })
      for (const x of s.supports)
        p.line(
          [x.item, x.who, x.purpose, x.amount == null ? '' : money(x.amount)]
            .filter(Boolean)
            .join(' - ')
        )
      // A file not in Bundle.pdf carries none of its marks; say only what was drawn, and where the rest are.
      if (path) s.notDrawn = s.marks
      const drawn = s.marks.length - s.notDrawn.length
      if (drawn) {
        p.gap()
        p.line(
          `${howMany(drawn, 'place')} highlighted on this copy, for ${s.supports[0]?.item ?? 'this item'} alone.`
        )
      }
      if (s.notDrawn.length) {
        p.gap()
        p.line(NOT_DRAWN)
        for (const m of s.notDrawn) p.line(markPlace(m))
      }
      if (path) {
        p.gap()
        p.line(
          IN_PDF.has(s.doc.contentType)
            ? 'This file could not be added to this PDF. The original is in the zip as:'
            : 'This file cannot go into a PDF. The original is in the zip as:'
        )
        p.line(path)
      }
    }

    // 1. The signed monthly report, or a cover page saying it is not on file yet.
    const signedSection = ordered.find((s) => s.part === 'signed')
    const signedPages = signedSection ? await content(signedSection) : null
    if (signedSection && signedPages) {
      const from = pageNo()
      signedPages()
      where.set(signedSection.doc.id, pagesWords(from, pageNo() - 1))
    } else {
      const from = pageNo()
      const p = new Pager(pdf, font, bold)
      p.line(`${title}: ${month}`, { size: 16, bold: true })
      p.line(`${c.workspace.name} - funder: ${c.funder ?? 'not named'}`)
      p.gap(16)
      if (signedSection) {
        const path = supportingPath(signedSection)
        where.set(signedSection.doc.id, path)
        p.line('The signed monthly report is on file but cannot go into this PDF.', { bold: true })
        p.line(`The original is in the zip as: ${path}`)
      } else {
        p.line('The signed monthly report is not on file yet.', { bold: true })
        p.line('Attach the signed copy on the month page, then download the bundle again.')
      }
      p.gap(16)
      p.line(`Month status: ${REPORT_STATUS_LABELS[r.status as ReportStatus] ?? r.status}`)
      generated('Cover page', from, pageNo() - 1)
    }

    // 2. The ledger summary.
    {
      const from = pageNo()
      const p = new Pager(pdf, font, bold)
      p.line(`Ledger summary: ${month}`, { size: 14, bold: true })
      p.line(title)
      p.gap()
      const right = PAGE[0] - MARGIN
      const cols = (a: string, b: string, v: string, l: string, amt: string) => [
        { text: a, x: MARGIN, width: 76 },
        { text: b, x: MARGIN + 80, width: 66 },
        { text: v, x: MARGIN + 150, width: 166 },
        { text: l, x: MARGIN + 320, width: 116 },
        { text: amt, x: right, width: 64, right: true },
      ]
      p.row(cols('Item #', 'Date', 'Vendor', 'Report line', 'Allocated'), { size: 9, bold: true })
      const totals = new Map<string, number>()
      for (const e of r.expenses) {
        const amount = Number(e.allocatedAmount)
        totals.set(e.reportLine, (totals.get(e.reportLine) ?? 0) + amount)
        p.row(cols(e.itemNumber, day(e.date), e.vendor, lineLabel(e.reportLine), money(amount)), {
          size: 9,
        })
      }
      if (!r.expenses.length) p.line('No expense lines this month.', { size: 9 })
      p.gap()
      p.line('Totals by report line', { bold: true })
      for (const [line, t] of totals)
        p.row([
          { text: lineLabel(line), x: MARGIN, width: 300 },
          { text: money(t), x: right, width: 100, right: true },
        ])
      p.row(
        [
          { text: 'Total this month', x: MARGIN, width: 300 },
          {
            text: money([...totals.values()].reduce((a, b) => a + b, 0)),
            x: right,
            width: 100,
            right: true,
          },
        ],
        { bold: true }
      )
      generated('Ledger summary', from, pageNo() - 1)
    }

    // 3 and 4. Each ledger line's records, then the payroll proof: a header page, then the record.
    for (const s of ordered) {
      if (s.part === 'signed') continue
      const pages = await content(s)
      const from = pageNo()
      const path = pages ? null : supportingPath(s)
      header(s, path)
      pages?.()
      where.set(s.doc.id, path ?? pagesWords(from, pageNo() - 1))
    }

    for (const s of ordered) {
      const placed = where.get(s.doc.id) ?? ''
      const section =
        s.part === 'signed'
          ? 'Signed report'
          : s.part === 'ledger'
            ? 'Ledger records'
            : 'Payroll proof'
      for (const x of s.supports.length ? s.supports : [null])
        index.push([
          section,
          x?.item ?? '',
          x?.who ?? '',
          x?.purpose ?? '',
          x?.amount == null ? '' : x.amount.toFixed(2),
          s.doc.kind,
          s.doc.fileName,
          placed,
          day(s.doc.uploadedAt),
          s.doc.sha256,
        ])
    }
    // Each signed copy submitted before the month was reopened: as uploaded, beside the bundle, never in Bundle.pdf.
    const earlier: [string, string][] = []
    const earlierPath = new Map<Reopening, string>()
    for (const o of r.reopenings) {
      const d = monthDocs.find((x) => x.id === o.signedDocumentId)
      if (!d || isPersonal(d)) continue
      if (d.workspaceId !== workspaceId || !keyInWorkspace(d)) throw new NotFoundException()
      let path = `Earlier submissions/${earlierSignedName(o.submittedAt, ext(d.fileName))}`
      for (let n = 2; seen.has(path); n++)
        path = `Earlier submissions/${earlierSignedName(o.submittedAt, ` (${n})${ext(d.fileName)}`)}`
      seen.add(path)
      earlier.push([path, d.storageKey])
      earlierPath.set(o, path)
      index.push([
        'Earlier submission',
        'Monthly report',
        '',
        `Signed report as submitted ${day(o.submittedAt)}`,
        '',
        d.kind,
        d.fileName,
        path,
        day(d.uploadedAt),
        d.sha256,
      ])
    }
    const bundle = await pdf.save()

    const status = REPORT_STATUS_LABELS[r.status as ReportStatus] ?? r.status
    const notDrawn = ordered.filter((s) => s.notDrawn.length)
    const readme = [
      `MONTHLY BUNDLE: ${title}, ${month}`,
      `Workspace: ${c.workspace.name}`,
      `Funder: ${c.funder ?? 'not named'}`,
      `Month status: ${status}${r.status === 'draft' ? ' (the ledger can still change)' : ''}`,
      `Month-end closing: ${r.authorizedAt ? `approved ${day(r.authorizedAt)} by ${r.authorizedByName ?? 'a person not named'}` : 'not approved yet'}`,
      `Submitted to the funder: ${r.submittedAt ? `${day(r.submittedAt)} by ${r.preparedByName ?? 'a person not named'}` : 'not submitted yet'}`,
      `Generated ${new Date().toISOString()} by ${staffName(caller)} from Audit Differently.`,
      '',
      'WHAT IS INSIDE',
      '  Bundle.pdf         one PDF to send with the invoice, in this order:',
      signed
        ? '                       the signed monthly report;'
        : '                       a cover page (the signed monthly report is not on file yet);',
      '                       a ledger summary: every line billed this month and the totals by report line;',
      "                       each line's supporting records in ledger order, each after a page naming the item;",
      '                       the payroll proof: payroll registers and bank statements, each marked payroll line',
      notDrawn.length
        ? '                       highlighted where it could be drawn (see MARKED LINES NOT DRAWN below).'
        : '                       highlighted (the stored statement is unchanged).',
      '  Supporting files/  records a PDF cannot hold (spreadsheets, Word files), named by item number',
      '  Index.csv          every record in this bundle, the item it supports and where it is',
      ...(r.reopenings.length
        ? [
            '  Earlier submissions/  each signed copy submitted before the month was reopened, as uploaded',
            '  Reopenings.csv     each reopening: the submission it undid, who reopened it, when and why',
            '',
            'REOPENED',
            `  ${reopenedWords(r.reopenings.length)}`,
          ]
        : []),
      '',
      'PERSONAL RECORDS',
      '  Personal records (pay stubs, eligibility records, enrollment forms) are never in a monthly bundle,',
      '  whoever downloads it: the funder did not ask for them by name.',
      personalLeftOut.size
        ? `  ${howMany(personalLeftOut.size, 'personal record')} of this month ${personalLeftOut.size === 1 ? 'was' : 'were'} left out.`
        : '  This month has none.',
      '',
      ...(notDrawn.length
        ? [
            'MARKED LINES NOT DRAWN',
            ...notDrawn.flatMap((s) => [
              `  ${s.doc.fileName} (${where.get(s.doc.id) ?? ''})`,
              `    ${NOT_DRAWN}`,
              ...s.notDrawn.map((m) => `      ${markPlace(m)}`),
            ]),
            '',
          ]
        : []),
    ].join('\n')

    const files = ordered.length + earlier.length
    return {
      name: `${root}.zip`,
      workspaceId,
      reportId: r.id,
      files,
      description: `Downloaded the ${month} bundle of ${c.name}: ${howMany(files, 'file')}`,
      entries: [
        [`${root}/README.txt`, strToU8(readme)],
        [`${root}/Index.csv`, strToU8(csv(index))],
        [`${root}/Bundle.pdf`, bundle],
        ...(r.reopenings.length
          ? [
              [
                `${root}/Reopenings.csv`,
                strToU8(
                  csv(reopeningRows(r.reopenings, (o) => earlierPath.get(o) ?? 'not on file'))
                ),
              ] as [string, ZipSource],
            ]
          : []),
        ...[...supporting, ...earlier].map(([path, key]): [string, ZipSource] => [
          `${root}/${path}`,
          async () => new Uint8Array(await this.storage.read(key)),
        ]),
      ],
    }
  }

  /** One line per download, written before the zip is sent; a refused request writes none. */
  async logDownload(caller: Caller, bundle: MonthBundle): Promise<void> {
    await this.log.log(caller, {
      workspaceId: bundle.workspaceId,
      resource: 'export',
      subjectId: bundle.reportId,
      action: 'export',
      description: bundle.description,
    })
  }

  /** The zip as chunks, one supporting file in memory at a time. */
  stream(bundle: MonthBundle): AsyncGenerator<Uint8Array> {
    return zipEntries(bundle.entries)
  }
}

const pagesWords = (from: number, to: number) =>
  from === to ? `Bundle.pdf, page ${from}` : `Bundle.pdf, pages ${from}-${to}`
