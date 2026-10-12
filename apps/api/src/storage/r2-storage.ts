import { Injectable, Logger } from '@nestjs/common'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createReadStream } from 'node:fs'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { assertFolderPrefix, type DocumentStorage } from './document-storage.interface'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required when R2_DOCUMENTS_BUCKET is set`)
  return value
}

/** Cloudflare R2 through the S3 API. One private bucket; objects are never public. */
@Injectable()
export class R2DocumentStorage implements DocumentStorage {
  private readonly logger = new Logger(R2DocumentStorage.name)
  private readonly s3: S3Client | null
  private readonly bucket: string

  constructor() {
    const bucket = process.env.R2_DOCUMENTS_BUCKET
    if (!bucket) {
      this.s3 = null
      this.bucket = ''
      return
    }
    this.bucket = bucket
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: required('R2_ACCESS_KEY_ID'),
        secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
      },
    })
    this.logger.log(`R2 document storage configured for bucket "${this.bucket}"`)
  }

  private client(): S3Client {
    if (!this.s3) throw new Error('R2DocumentStorage used without R2_DOCUMENTS_BUCKET set')
    return this.s3
  }

  async upload(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.client().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    )
  }

  async read(key: string): Promise<Buffer> {
    const out = await this.client().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    const bytes = await out.Body!.transformToByteArray()
    return Buffer.from(bytes)
  }

  async getSignedUrl(
    key: string,
    expiresInSeconds: number,
    options?: { downloadName?: string; inlineName?: string }
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: options?.downloadName
        ? disposition('attachment', options.downloadName)
        : options?.inlineName
          ? disposition('inline', options.inlineName)
          : undefined,
    })
    return getSignedUrl(this.client(), command, { expiresIn: expiresInSeconds })
  }

  async delete(key: string): Promise<void> {
    await this.client().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  /** Lists and deletes a page (up to 1000 keys) at a time until nothing is left; any key R2 refuses is an error. */
  async deleteByPrefix(prefix: string): Promise<void> {
    assertFolderPrefix(prefix)
    let token: string | undefined
    do {
      const page = await this.client().send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []))
      if (keys.length > 0) {
        const res = await this.client().send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys, Quiet: true },
          })
        )
        if (res.Errors?.length)
          throw new Error(`R2 refused to delete ${res.Errors.length} objects under ${prefix}`)
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }

  async putFile(key: string, filePath: string, size: number, contentType: string): Promise<void> {
    await this.client().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
      })
    )
  }
}

/** A Content-Disposition value that keeps the original file name: a plain fallback and the UTF-8 form. */
export function disposition(kind: 'attachment' | 'inline', name: string): string {
  const clean = [...name]
    .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127 && !'"\\/'.includes(c))
    .join('')
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`
}
