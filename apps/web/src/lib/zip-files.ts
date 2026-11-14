import { unzip, unzipSync } from 'fflate'
import { PAYROLL_FOLDERS, RECEIPTS_FOLDER } from '@ad/types'

/** What an upload accepts, by extension, and the type the browser gives each when it comes out of a zip. */
export const UPLOAD_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv',
}

export interface ZippedFile {
  file: File
  /** Where it sat inside the zip ("Pay stubs/paystub-….pdf"). */
  path: string
  /** The folder it sat in inside the zip ("Pay stubs"), or "" at the top. */
  folder: string
}

/** An inner zip's files are opened up to these sizes (the server's file limit, and the payroll zip's). */
const INNER_FILE_MAX_BYTES = 25 * 1024 * 1024
const INNER_TOTAL_MAX_BYTES = 250 * 1024 * 1024

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/**
 * The files inside a zip, opened in the browser: the ones an upload accepts, with the folder each was in, and the
 * names of the rest (system files such as .DS_Store and __MACOSX are left out without a word). A zip inside it (a payroll
 * company's pay stubs come as one) is opened in place, one level: its files sit in the folder the inner zip sat in, as
 * they are. The server still checks every file it is sent, as it checks any upload.
 */
export function filesFromZip(zip: File): Promise<{ files: ZippedFile[]; skipped: string[] }> {
  return zip.arrayBuffer().then(
    (buf) =>
      new Promise((resolve, reject) =>
        unzip(new Uint8Array(buf), (err, entries) => {
          if (err) return reject(new Error(`${zip.name} could not be opened as a zip`))
          const files: ZippedFile[] = []
          const skipped: string[] = []
          const take = (path: string, bytes: Uint8Array, inner: boolean) => {
            if (path.endsWith('/')) return
            const parts = path.split('/')
            const name = parts[parts.length - 1]!
            if (parts.includes('__MACOSX') || name.startsWith('.')) return
            if (!inner && extOf(name) === 'zip') {
              // Each inner file up to the server's limit, all of them up to the zip's: never unpacked past that.
              let total = 0
              let opened: Record<string, Uint8Array>
              try {
                opened = unzipSync(bytes, {
                  filter: (f) => {
                    total += f.originalSize
                    return f.originalSize <= INNER_FILE_MAX_BYTES && total <= INNER_TOTAL_MAX_BYTES
                  },
                })
              } catch {
                skipped.push(path)
                return
              }
              const dir = parts.slice(0, -1).join('/')
              for (const [p, b] of Object.entries(opened)) {
                const inside = p.split('/')
                if (p.endsWith('/') || inside.includes('__MACOSX')) continue
                // At the top, it is the payroll zip itself (zipped again): its folders as they are. In a folder, its
                // files sit in that folder, an inner folder kept in the name ("Lee, Morgan - stub.pdf").
                take(dir ? `${dir}/${inside.join(' - ')}` : p, b, true)
              }
              return
            }
            const type = UPLOAD_TYPES[extOf(name)]
            if (!type) {
              skipped.push(path)
              return
            }
            files.push({
              file: new File([bytes as Uint8Array<ArrayBuffer>], name, { type }),
              path,
              folder: parts.length > 1 ? parts[parts.length - 2]! : '',
            })
          }
          for (const [path, bytes] of Object.entries(entries)) take(path, bytes, false)
          resolve({ files, skipped })
        })
      )
  )
}

// The payroll zip's folders and its Receipts folder are in @ad/types: File Management's download writes the same zip.
export { PAYROLL_FOLDERS, RECEIPTS_FOLDER }
export type PayrollFolderKind = (typeof PAYROLL_FOLDERS)[number][1]
/**
 * The folders a zip may leave out: the payroll company's per-person export (GitHub issue #22, section 8), and pay stubs
 * (a month of staff pay only has none to give).
 */
export const OPTIONAL_FOLDERS = new Set<string>(['QuickBooks transactions', 'Pay stubs'])
/** The folder of a program names file: the same program's names in the books and the payroll company, one row each. */
export const PROGRAM_NAMES_FOLDER = 'Program names'
/**
 * The folder of each engagement's account mapping (owner's decision, 2026-11-09): its chart of accounts mapped to the
 * categories its funder bills, one file per engagement. Not proof: it comes back apart, as program names do.
 */
export const ACCOUNT_MAPPING_FOLDER = 'Account mapping'
const ACCOUNT_MAPPING_NAMES = [ACCOUNT_MAPPING_FOLDER, 'Account mappings']
const RECEIPTS_NAMES = [RECEIPTS_FOLDER, 'Invoices', 'Receipts and invoices']
const RECEIPT_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg'])
/**
 * Other names a folder goes by (owner's decision, 2026-11-09): the bank's and the card's statements share one folder,
 * and the books' export is the whole month, its expenses too. The old names still open a zip made before.
 */
const FOLDER_ALIASES: Record<string, string[]> = {
  'Bank & card statements': ['Bank statements', 'Bank and card statements'],
  'QuickBooks transactions': ['Payroll details', 'Books transactions'],
}
const isFolder = (name: string, given: string) =>
  [name, ...(FOLDER_ALIASES[name] ?? [])].some((n) => same(n, given))
/** The folders a CSV may be in: the payroll company's journals, job reports and exports, and program names. */
const CSV_FOLDERS = new Set<string>(['Timesheets', 'Payroll registers', 'QuickBooks transactions'])

/**
 * A payroll zip checked against its required layout: the folders (QuickBooks transactions, Pay stubs, Program names, Account mapping and Receipts when the
 * team has them) and nothing else (a zip of the folder itself, one level up, is fine). Every problem at once, so the
 * person fixes the zip in one go. A program names file is not proof: it comes back apart, in `names`.
 */
export function sortPayrollZip(
  paths: { path: string; file: File }[],
  skipped: string[]
): {
  files: { file: File; kind: PayrollFolderKind; folder: string }[]
  names: File[]
  /** The zip's "Account mapping" files: not proof, sent to the engagements' account mappings. */
  mappings: File[]
  /** The zip's "Receipts" files: not payroll proof, sent to the month's receipts of the books' bills. */
  receipts: File[]
  problems: string[]
} {
  const problems: string[] = []
  const folders = [
    ...PAYROLL_FOLDERS.flatMap(([name]) => [name, ...(FOLDER_ALIASES[name] ?? [])]),
    PROGRAM_NAMES_FOLDER,
    ...ACCOUNT_MAPPING_NAMES,
    ...RECEIPTS_NAMES,
  ]
  // A zip of the folder itself puts everything under one top folder: look inside it.
  const tops = new Set(paths.map((p) => p.path.split('/')[0]))
  const strip =
    tops.size === 1 &&
    paths.every((p) => p.path.split('/').length >= 3) &&
    !folders.some((name) => same(name, [...tops][0]!))
  const files: { file: File; kind: PayrollFolderKind; folder: string }[] = []
  const names: File[] = []
  const mappings: File[] = []
  const receipts: File[] = []
  const outside: string[] = []
  const misplaced: string[] = []
  const unknown = new Set<string>()
  for (const p of paths) {
    const parts = p.path.split('/').slice(strip ? 1 : 0)
    if (parts.length !== 2) {
      outside.push(parts.join('/'))
      continue
    }
    const csv = extOf(parts[1]!) === 'csv'
    if (same(PROGRAM_NAMES_FOLDER, parts[0]!)) {
      if (csv || extOf(parts[1]!) === 'xlsx') names.push(p.file)
      else misplaced.push(parts.join('/'))
      continue
    }
    if (ACCOUNT_MAPPING_NAMES.some((n) => same(n, parts[0]!))) {
      if (csv || extOf(parts[1]!) === 'xlsx') mappings.push(p.file)
      else misplaced.push(parts.join('/'))
      continue
    }
    if (RECEIPTS_NAMES.some((n) => same(n, parts[0]!))) {
      if (RECEIPT_EXTS.has(extOf(parts[1]!))) receipts.push(p.file)
      else misplaced.push(parts.join('/'))
      continue
    }
    const folder = PAYROLL_FOLDERS.find(([name]) => isFolder(name, parts[0]!))
    if (!folder) {
      unknown.add(parts[0]!)
      continue
    }
    if (csv && !CSV_FOLDERS.has(folder[0])) {
      misplaced.push(parts.join('/'))
      continue
    }
    files.push({ file: p.file, kind: folder[1], folder: folder[0] })
  }
  for (const [name] of PAYROLL_FOLDERS)
    if (!OPTIONAL_FOLDERS.has(name) && !files.some((f) => f.folder === name))
      problems.push(`The zip has no "${name}" folder, or it is empty.`)
  if (unknown.size)
    problems.push(
      `${[...unknown].map((u) => `"${u}"`).join(', ')} ${unknown.size === 1 ? 'is not one of the folders' : 'are not among the folders'}: use Timesheets, Payroll registers, Pay stubs, Bank & card statements, QuickBooks transactions, Program names, Account mapping and Receipts.`
    )
  if (outside.length)
    problems.push(
      `${outside.length === 1 ? '1 file is' : `${outside.length} files are`} not inside one of the folders (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', …' : ''}).`
    )
  if (misplaced.length)
    problems.push(
      `${misplaced.length === 1 ? '1 file is' : `${misplaced.length} files are`} in a folder that does not take its type: a CSV goes in Timesheets, Payroll registers, QuickBooks transactions, Program names or Account mapping, Program names and Account mapping take an XLSX or CSV, and Receipts a PDF, PNG or JPG (${misplaced.slice(0, 3).join(', ')}${misplaced.length > 3 ? ', …' : ''}).`
    )
  if (skipped.length)
    problems.push(
      `${skipped.length === 1 ? '1 file is' : `${skipped.length} files are`} not a PDF, PNG, JPG, XLSX, DOCX, CSV or ZIP (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''}).`
    )
  return { files, names, mappings, receipts, problems }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
