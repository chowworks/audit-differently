import { unzip } from 'fflate'

/** What an upload accepts, by extension, and the type the browser gives each when it comes out of a zip. */
export const UPLOAD_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export interface ZippedFile {
  file: File
  /** Where it sat inside the zip ("Pay stubs/paystub-….pdf"). */
  path: string
  /** The folder it sat in inside the zip ("Pay stubs"), or "" at the top. */
  folder: string
}

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/**
 * The files inside a zip, opened in the browser: the ones an upload accepts, with the folder each was in, and the
 * names of the rest (system files such as .DS_Store and __MACOSX are left out without a word). The server still checks
 * every file it is sent, as it checks any upload.
 */
export function filesFromZip(zip: File): Promise<{ files: ZippedFile[]; skipped: string[] }> {
  return zip.arrayBuffer().then(
    (buf) =>
      new Promise((resolve, reject) =>
        unzip(new Uint8Array(buf), (err, entries) => {
          if (err) return reject(new Error(`${zip.name} could not be opened as a zip`))
          const files: ZippedFile[] = []
          const skipped: string[] = []
          for (const [path, bytes] of Object.entries(entries)) {
            if (path.endsWith('/')) continue
            const parts = path.split('/')
            const name = parts[parts.length - 1]!
            if (parts.includes('__MACOSX') || name.startsWith('.')) continue
            const type = UPLOAD_TYPES[extOf(name)]
            if (!type) {
              skipped.push(path)
              continue
            }
            files.push({
              file: new File([bytes], name, { type }),
              path,
              folder: parts.length > 1 ? parts[parts.length - 2]! : '',
            })
          }
          resolve({ files, skipped })
        })
      )
  )
}

/** The payroll zip's folders, as the sample has them, and the document type each holds. */
export const PAYROLL_FOLDERS = [
  ['Timesheets', 'timesheet'],
  ['Payroll registers', 'payroll-register'],
  ['Pay stubs', 'paystub'],
  ['Bank statements', 'bank-statement'],
  ['Payroll details', 'payroll-details'],
] as const
export type PayrollFolderKind = (typeof PAYROLL_FOLDERS)[number][1]
/** The folder a zip may leave out (GitHub issue #22, section 8): the payroll company's per-person export. */
const OPTIONAL_FOLDERS = new Set<string>(['Payroll details'])

/**
 * A payroll zip checked against its required layout: the four folders (and Payroll details, when the team has it) and
 * nothing else (a zip of the folder itself,
 * one level up, is fine). Every problem at once, so the person fixes the zip in one go.
 */
export function sortPayrollZip(
  paths: { path: string; file: File }[],
  skipped: string[]
): { files: { file: File; kind: PayrollFolderKind; folder: string }[]; problems: string[] } {
  const problems: string[] = []
  // A zip of the folder itself puts everything under one top folder: look inside it.
  const tops = new Set(paths.map((p) => p.path.split('/')[0]))
  const strip =
    tops.size === 1 &&
    paths.every((p) => p.path.split('/').length >= 3) &&
    !PAYROLL_FOLDERS.some(([name]) => same(name, [...tops][0]!))
  const files: { file: File; kind: PayrollFolderKind; folder: string }[] = []
  const outside: string[] = []
  const unknown = new Set<string>()
  for (const p of paths) {
    const parts = p.path.split('/').slice(strip ? 1 : 0)
    if (parts.length !== 2) {
      outside.push(parts.join('/'))
      continue
    }
    const folder = PAYROLL_FOLDERS.find(([name]) => same(name, parts[0]!))
    if (!folder) {
      unknown.add(parts[0]!)
      continue
    }
    files.push({ file: p.file, kind: folder[1], folder: folder[0] })
  }
  for (const [name] of PAYROLL_FOLDERS)
    if (!OPTIONAL_FOLDERS.has(name) && !files.some((f) => f.folder === name))
      problems.push(`The zip has no "${name}" folder, or it is empty.`)
  if (unknown.size)
    problems.push(
      `${[...unknown].map((u) => `"${u}"`).join(', ')} ${unknown.size === 1 ? 'is not one of the folders' : 'are not among the folders'}: use Timesheets, Payroll registers, Pay stubs, Bank statements and Payroll details.`
    )
  if (outside.length)
    problems.push(
      `${outside.length === 1 ? '1 file is' : `${outside.length} files are`} not inside one of the folders (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', …' : ''}).`
    )
  if (skipped.length)
    problems.push(
      `${skipped.length === 1 ? '1 file is' : `${skipped.length} files are`} not a PDF, PNG, JPG, XLSX or DOCX (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''}).`
    )
  return { files, problems }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
