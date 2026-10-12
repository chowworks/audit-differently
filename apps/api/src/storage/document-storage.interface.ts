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
   * (Content-Disposition: attachment) instead of rendering in the browser.
   */
  getSignedUrl(
    key: string,
    expiresInSeconds: number,
    options?: { downloadName?: string }
  ): Promise<string>
  delete(key: string): Promise<void>
  /** The bytes under `key`, for the audit package. */
  read(key: string): Promise<Buffer>
}

export const DOCUMENT_STORAGE = 'DOCUMENT_STORAGE'
