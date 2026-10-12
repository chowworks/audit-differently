import { Injectable, Logger } from '@nestjs/common'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { assertFolderPrefix, type DocumentStorage } from './document-storage.interface'

/**
 * Local development only: files under apps/api/storage/ (gitignored), served by the documents controller
 * at /api/documents/local/<token>. The token is signed with a secret made at startup and carries the key and
 * an expiry, so a link is as short-lived as a real signed URL and useless after a restart. Never used in a
 * deployed environment: the module picks R2 when R2_DOCUMENTS_BUCKET is set.
 */
@Injectable()
export class LocalDiskStorage implements DocumentStorage {
  private readonly logger = new Logger(LocalDiskStorage.name)
  private readonly root = path.resolve(process.cwd(), 'storage')
  private readonly secret = randomBytes(32)

  constructor() {
    this.logger.log(`Local document storage at ${this.root}`)
  }

  private pathFor(key: string): string {
    const resolved = path.resolve(this.root, key)
    if (!resolved.startsWith(this.root + path.sep)) throw new Error(`Invalid storage key: ${key}`)
    return resolved
  }

  async upload(key: string, buffer: Buffer): Promise<void> {
    const file = this.pathFor(key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, buffer)
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key))
  }

  async getSignedUrl(
    key: string,
    expiresInSeconds: number,
    options?: { downloadName?: string; inlineName?: string }
  ): Promise<string> {
    const payload = Buffer.from(
      JSON.stringify({
        key,
        exp: Date.now() + expiresInSeconds * 1000,
        name: options?.downloadName,
      })
    ).toString('base64url')
    const sig = createHmac('sha256', this.secret).update(payload).digest('base64url')
    const base = process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
    return `${base}/api/documents/local/${payload}.${sig}`
  }

  /** The key and download name a token stands for, or null if it is forged or expired. */
  verify(token: string): { key: string; downloadName?: string } | null {
    const dot = token.lastIndexOf('.')
    if (dot < 0) return null
    const payload = token.slice(0, dot)
    const sig = Buffer.from(token.slice(dot + 1), 'base64url')
    const expected = createHmac('sha256', this.secret).update(payload).digest()
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null
    try {
      const { key, exp, name } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
        key: string
        exp: number
        name?: string
      }
      if (typeof key !== 'string' || typeof exp !== 'number' || Date.now() > exp) return null
      return { key, downloadName: name }
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true })
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    assertFolderPrefix(prefix)
    await rm(this.pathFor(prefix), { recursive: true, force: true })
  }

  async putFile(key: string, filePath: string): Promise<void> {
    const file = this.pathFor(key)
    await mkdir(path.dirname(file), { recursive: true })
    await copyFile(filePath, file)
  }
}
