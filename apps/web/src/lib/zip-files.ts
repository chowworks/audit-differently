import { unzip, unzipSync } from 'fflate'
import {
  ACCOUNT_MAPPING_FOLDER,
  PAYROLL_FOLDERS,
  PROGRAM_NAMES_FOLDER,
  RECEIPTS_FOLDER,
  ZIP_FOLDERS,
  ZIP_FOLDER_LIST,
  andList,
  type ZipFolder,
} from '@ad/types'

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

// The zip's folders are one list, ZIP_FOLDER_LIST in @ad/types: everything here is read from it.
export {
  ACCOUNT_MAPPING_FOLDER,
  PAYROLL_FOLDERS,
  PROGRAM_NAMES_FOLDER,
  RECEIPTS_FOLDER,
  ZIP_FOLDERS,
}
export type PayrollFolderKind = (typeof PAYROLL_FOLDERS)[number][1]
/** The folders a zip may leave out. */
export const OPTIONAL_FOLDERS = new Set<string>(
  ZIP_FOLDER_LIST.filter((f) => !f.required).map((f) => f.name)
)
const namesOf = (f: ZipFolder) => [f.name, ...f.aliases]
const isFolder = (f: ZipFolder, given: string) => namesOf(f).some((n) => same(n, given))
const folderOf = (given: string) =>
  (ZIP_FOLDER_LIST as readonly ZipFolder[]).find((f) => isFolder(f, given))
const types = (exts: readonly string[]) =>
  andList([...new Set(exts.map((e) => (e === 'jpeg' ? 'jpg' : e).toUpperCase()))]).replace(
    / and /,
    ' or '
  )
/** Which folder takes which file type, in words, for a file in a folder that does not take it. */
const whatGoesWhere = () => {
  const csv = ZIP_FOLDERS.filter((n) => folderOf(n)!.extensions.includes('csv'))
  const narrow = (ZIP_FOLDER_LIST as readonly ZipFolder[]).filter(
    (f) => f.holds !== 'payroll-proof'
  )
  return `a CSV goes in ${andList(csv).replace(/ and ([^,]*)$/, ' or $1')}, ${narrow
    .map((f) => `${f.name} takes ${types(f.extensions)}`)
    .join(', ')}`
}

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
  const folders = (ZIP_FOLDER_LIST as readonly ZipFolder[]).flatMap(namesOf)
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
    const folder = folderOf(parts[0]!)
    if (!folder) {
      unknown.add(parts[0]!)
      continue
    }
    const ext = extOf(parts[1]!)
    // A payroll proof file's type is checked again on upload; here only a CSV where it is not taken.
    if (
      folder.holds === 'payroll-proof'
        ? ext === 'csv' && !folder.extensions.includes('csv')
        : !folder.extensions.includes(ext)
    ) {
      misplaced.push(parts.join('/'))
      continue
    }
    if (folder.holds === 'program-names') names.push(p.file)
    else if (folder.holds === 'account-mapping') mappings.push(p.file)
    else if (folder.holds === 'receipts') receipts.push(p.file)
    else files.push({ file: p.file, kind: folder.kind as PayrollFolderKind, folder: folder.name })
  }
  for (const f of ZIP_FOLDER_LIST)
    if (f.required && !files.some((x) => x.folder === f.name))
      problems.push(`The zip has no "${f.name}" folder, or it is empty.`)
  if (unknown.size)
    problems.push(
      `${[...unknown].map((u) => `"${u}"`).join(', ')} ${unknown.size === 1 ? 'is not one of the folders' : 'are not among the folders'}: use ${andList(ZIP_FOLDERS)}.`
    )
  if (outside.length)
    problems.push(
      `${outside.length === 1 ? '1 file is' : `${outside.length} files are`} not inside one of the folders (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', …' : ''}).`
    )
  if (misplaced.length)
    problems.push(
      `${misplaced.length === 1 ? '1 file is' : `${misplaced.length} files are`} in a folder that does not take its type: ${whatGoesWhere()} (${misplaced.slice(0, 3).join(', ')}${misplaced.length > 3 ? ', …' : ''}).`
    )
  if (skipped.length)
    problems.push(
      `${skipped.length === 1 ? '1 file is' : `${skipped.length} files are`} not a PDF, PNG, JPG, XLSX, DOCX, CSV or ZIP (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''}).`
    )
  return { files, names, mappings, receipts, problems }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
