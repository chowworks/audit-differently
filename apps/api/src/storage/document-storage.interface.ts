/**
 * Private object storage for provider documents (invoices, statements, registers, timesheets). There is no
 * public flavour on purpose: nothing in this product is ever served from a public URL. The database stores
 * the key; a reader gets a short-lived signed URL, and the read is written to DataAccessLog by the caller.
 */
export interface DocumentStorage {
  /** Upload bytes under `key`. Persist `key` in the database; the URL is generated on demand. */
  upload(key: string, buffer: Buffer, contentType: string): Promise<void>
  /**
   * Time-limited signed URL for `key`. With `downloadName` the link forces a download
   * (Content-Disposition: attachment) instead of rendering in the browser; with `inlineName` it renders
   * in the browser and, if the person saves it, keeps that file name.
   */
  getSignedUrl(
    key: string,
    expiresInSeconds: number,
    options?: { downloadName?: string; inlineName?: string }
  ): Promise<string>
  delete(key: string): Promise<void>
  /**
   * Deletes every object whose key starts with `prefix`, which must end in '/' (a folder: `<workspaceId>/` or
   * `<workspaceId>/<engagementId>/`). Safe to repeat. Refuses a prefix that is not a folder.
   */
  deleteByPrefix(prefix: string): Promise<void>
  /**
   * Stores the file at `filePath` (`size` bytes) under `key` without holding it in memory. For the retained copy
   * of a deletion export, which lives outside the workspace-first key layout (CLAUDE.md, "Deleting").
   */
  putFile(key: string, filePath: string, size: number, contentType: string): Promise<void>
  /** The bytes under `key`, for the audit package. */
  read(key: string): Promise<Buffer>
}

export const DOCUMENT_STORAGE = 'DOCUMENT_STORAGE'

/** A prefix is a folder: non-empty segments, a trailing slash, nothing that climbs out, and never the retained copies' folder. */
export function assertFolderPrefix(prefix: string): void {
  if (
    !/^[^/\\]+(\/[^/\\]+)*\/$/.test(prefix) ||
    prefix.split('/').includes('..') ||
    prefix.startsWith('retained/')
  )
    throw new Error(`Not a storage folder: ${prefix}`)
}
