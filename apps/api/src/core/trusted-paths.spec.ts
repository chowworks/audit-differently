import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every place the API acts as trusted work (runAsSystem: every workspace, no person, the app.system mark that
 * the User/Membership/Workspace policies admit). A new call site is a review item: add it here on purpose.
 */
const TRUSTED_CALL_SITES = [
  'deletion/deletion.service.ts', // deleting a workspace, after the owner check and only once it holds no engagement
  'documents/documents.controller.ts', // the local-disk file behind a signed token (404 whenever R2 is set)
  'inbound/inbound.service.ts', // emailed receipts before anyone is known: queue, claim, address, sender, outcome
  'me/me.controller.ts', // first sign-in: the User row and the takeover of an invitation's placeholder
  'payroll/payroll-match.sweeper.ts', // expiring payroll matches left past RUN_HOURS: the run, its line in the starter's name, its staged objects
  'payroll/payroll-match.worker.ts', // reading payroll match files: claim, read, write only what was read (20261016001300)
  'workspaces/workspaces.service.ts', // an owner's invitation: the lookup by email and the placeholder
]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

describe('trusted work', () => {
  it('runs only from the call sites written down here', () => {
    const root = join(__dirname, '..')
    const callers = files(root)
      .filter(
        (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('tenant-context.ts')
      )
      .filter((f) => /\brunAsSystem\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f))
      .sort()
    expect(callers).toEqual([...TRUSTED_CALL_SITES].sort())
  })
})
