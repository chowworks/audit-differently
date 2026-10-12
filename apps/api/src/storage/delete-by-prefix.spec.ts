import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { DocumentStorage } from './document-storage.interface'
import { LocalDiskStorage } from './local-disk-storage'
import { R2DocumentStorage } from './r2-storage'

const BAD_PREFIXES = ['', '/', 'ws-1', 'ws-1/e-1', '../ws-1/', 'ws-1/../ws-2/', '//', 'retained/']

describe('LocalDiskStorage deleteByPrefix and putFile', () => {
  let dir: string
  let storage: DocumentStorage
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ad-storage-'))
    jest.spyOn(process, 'cwd').mockReturnValue(dir)
    storage = new LocalDiskStorage()
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })
  const has = (key: string) => existsSync(path.join(dir, 'storage', key))

  it('removes everything under the folder, and not a folder that only starts the same way', async () => {
    for (const k of ['ws-1/e-1/2026-07/a.pdf', 'ws-1/e-1/general/b.pdf', 'ws-1/e-10/general/c.pdf'])
      await storage.upload(k, Buffer.from('x'), 'application/pdf')
    await storage.deleteByPrefix('ws-1/e-1/')
    expect(has('ws-1/e-1/2026-07/a.pdf')).toBe(false)
    expect(has('ws-1/e-1/general/b.pdf')).toBe(false)
    expect(has('ws-1/e-10/general/c.pdf')).toBe(true)
    await storage.deleteByPrefix('ws-1/e-1/') // repeating is fine
    await storage.deleteByPrefix('ws-1/')
    expect(has('ws-1/e-10/general/c.pdf')).toBe(false)
  })

  it.each(BAD_PREFIXES)('refuses %j as a folder', async (prefix) => {
    await storage.upload('ws-1/e-1/general/a.pdf', Buffer.from('x'), 'application/pdf')
    await expect(storage.deleteByPrefix(prefix)).rejects.toThrow(/Not a storage folder/)
    expect(has('ws-1/e-1/general/a.pdf')).toBe(true)
  })

  it('stores a file under a key outside the workspace layout', async () => {
    const src = path.join(dir, 'src.zip')
    await writeFile(src, 'zip bytes')
    await storage.putFile('retained/ws-1/e-1-2026.zip', src, 9, 'application/zip')
    expect(await readFile(path.join(dir, 'storage/retained/ws-1/e-1-2026.zip'), 'utf8')).toBe(
      'zip bytes'
    )
    await mkdir(path.join(dir, 'x'), { recursive: true })
  })
})

describe('R2DocumentStorage deleteByPrefix and putFile', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
  })
  function r2() {
    Object.assign(process.env, {
      R2_DOCUMENTS_BUCKET: 'bucket',
      R2_ACCOUNT_ID: 'acct',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
    })
    const storage = new R2DocumentStorage()
    const send = jest.fn()
    ;(storage as unknown as { s3: { send: jest.Mock } }).s3 = { send }
    return { storage, send }
  }

  it('lists and deletes page after page until nothing is left', async () => {
    const { storage, send } = r2()
    send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command)
        return cmd.input.ContinuationToken
          ? { Contents: [{ Key: 'ws-1/e-1/c' }], IsTruncated: false }
          : {
              Contents: [{ Key: 'ws-1/e-1/a' }, { Key: 'ws-1/e-1/b' }],
              IsTruncated: true,
              NextContinuationToken: 'next',
            }
      return {}
    })
    await storage.deleteByPrefix('ws-1/e-1/')
    const cmds = send.mock.calls.map((c) => c[0])
    expect(cmds.map((c) => c.constructor.name)).toEqual([
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
    ])
    expect((cmds[0] as ListObjectsV2Command).input).toMatchObject({
      Bucket: 'bucket',
      Prefix: 'ws-1/e-1/',
    })
    expect((cmds[1] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([
      { Key: 'ws-1/e-1/a' },
      { Key: 'ws-1/e-1/b' },
    ])
    expect((cmds[3] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([{ Key: 'ws-1/e-1/c' }])
  })

  it('does nothing for an empty folder, and fails when R2 refuses a key', async () => {
    const { storage, send } = r2()
    send.mockResolvedValueOnce({ IsTruncated: false })
    await storage.deleteByPrefix('ws-1/')
    expect(send).toHaveBeenCalledTimes(1)
    send.mockReset()
    send.mockImplementation(async (cmd: unknown) =>
      cmd instanceof ListObjectsV2Command
        ? { Contents: [{ Key: 'ws-1/a' }] }
        : { Errors: [{ Key: 'ws-1/a', Code: 'AccessDenied' }] }
    )
    await expect(storage.deleteByPrefix('ws-1/')).rejects.toThrow(/refused to delete 1 objects/)
  })

  it.each(BAD_PREFIXES)('refuses %j as a folder without calling R2', async (prefix) => {
    const { storage, send } = r2()
    await expect(storage.deleteByPrefix(prefix)).rejects.toThrow(/Not a storage folder/)
    expect(send).not.toHaveBeenCalled()
  })

  it('puts a file with its length, so it is never held in memory', async () => {
    const { storage, send } = r2()
    send.mockResolvedValue({})
    await storage.putFile('retained/ws-1/e-1-x.zip', __filename, 123, 'application/zip')
    const cmd = send.mock.calls[0][0] as PutObjectCommand
    expect(cmd).toBeInstanceOf(PutObjectCommand)
    expect(cmd.input).toMatchObject({
      Bucket: 'bucket',
      Key: 'retained/ws-1/e-1-x.zip',
      ContentLength: 123,
    })
    ;(cmd.input.Body as { destroy(): void }).destroy()
  })
})
