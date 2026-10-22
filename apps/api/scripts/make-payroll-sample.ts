/**
 * Writes the workspace payroll sample (GitHub issue #22): fictional text-layer PDFs for one September 2026 pay run of
 * Riverbend Youth Services (prisma/payroll-workspace-sample.ts) into docs/samples/payroll-2026-09-workspace/, in the
 * five folders the workspace payroll upload reads (Payroll details included), and zips them as apps/web/public/samples/payroll-workspace-sample.zip
 * (the workspace payroll page's "Download a sample (zip)"). Touches no database and no storage: files on this disk only.
 * The per-engagement wizard's payroll-sample.zip is left as it is.
 *
 *   npm run sample:payroll -w @ad/api
 */
import { zipSync } from 'fflate'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sampleFiles } from '../prisma/payroll-workspace-sample'

const ROOT = join(__dirname, '../../..')
const DIR = join(ROOT, 'docs/samples/payroll-2026-09-workspace')
const ZIP = join(ROOT, 'apps/web/public/samples/payroll-workspace-sample.zip')
// A fixed time on every entry, so the same sample always makes the same zip; in local terms, since a zip stores local
// clock time, so every time zone makes the same bytes.
const MTIME = new Date(2026, 9, 1, 12, 0, 0)

async function main() {
  const files = await sampleFiles()
  rmSync(DIR, { recursive: true, force: true })
  const zip: Record<string, [Uint8Array, { mtime: Date }]> = {}
  for (const f of files) {
    mkdirSync(join(DIR, f.folder), { recursive: true })
    writeFileSync(join(DIR, f.folder, f.name), f.bytes)
    zip[`${f.folder}/${f.name}`] = [new Uint8Array(f.bytes), { mtime: MTIME }]
  }
  writeFileSync(ZIP, zipSync(zip, { level: 9 }))
  console.log(`Wrote ${files.length} files to ${DIR} and ${ZIP}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
