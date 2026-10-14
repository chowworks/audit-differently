import { TERMS_REQUIRED_CODE } from '@ad/types'

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown
  ) {
    super(message)
  }
}

/** Fired on `window` when the API refuses a call because the Terms changed since this tab loaded; the app then asks /me again. */
export const TERMS_REQUIRED_EVENT = 'ad:terms-required'

/** Fired on `window` after a change to the caller's own memberships (an admin named themself an owner); the app asks /me again. */
export const ME_CHANGED_EVENT = 'ad:me-changed'

/** Hashing reads the whole file into memory; above this the tab could freeze, so only the size is checked. */
const HASH_LIMIT_BYTES = 500 * 1024 * 1024

const sha256Hex = async (blob: Blob) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/**
 * Downloads a file from the API with the caller's token and hands it to the browser. When the API says what it
 * sent (X-Export-Bytes, X-Export-Sha256) the bytes received are checked against it first, and a file that does
 * not match is not saved. A JSON answer (the list of parts of a big audit package) is returned instead of saved.
 */
export async function apiDownload<T = never>(
  path: string,
  token: string | null,
  fileName: string
): Promise<T | null> {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_URL}/api${path}`, { headers })
  if (!response.ok) {
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      /* no body */
    }
    const message =
      body &&
      typeof body === 'object' &&
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `Download failed (${response.status})`
    throw new ApiError(response.status, message, body)
  }
  if ((response.headers.get('Content-Type') ?? '').includes('application/json'))
    return (await response.json()) as T
  const blob = await response.blob()
  const sentBytes = response.headers.get('X-Export-Bytes')
  const sentHash = response.headers.get('X-Export-Sha256')
  const incomplete = new ApiError(0, 'That download looks incomplete, try again.', null)
  if (sentBytes !== null && blob.size !== Number(sentBytes)) throw incomplete
  if (sentHash && blob.size <= HASH_LIMIT_BYTES && globalThis.crypto?.subtle)
    if ((await sha256Hex(blob)) !== sentHash) throw incomplete
  const named = /filename="?([^";]+)"?/i.exec(response.headers.get('Content-Disposition') ?? '')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = named ? named[1]! : fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return null
}

/** A JSON call to the API with the caller's token. Throws ApiError on a non-2xx response. */
export async function apiFetch<T>(
  path: string,
  token: string | null,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_URL}/api${path}`, { ...init, headers })
  if (!response.ok) {
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      /* no body */
    }
    // The rate limit's own text ("ThrottlerException: Too Many Requests") is not for people.
    const message =
      response.status === 429
        ? 'Too many requests just now. Wait a minute, then try again.'
        : ((body &&
          typeof body === 'object' &&
          'message' in body &&
          typeof (body as { message: unknown }).message === 'string'
            ? (body as { message: string }).message
            : null) ?? `${init.method ?? 'GET'} ${path} failed (${response.status})`)
    if (
      response.status === 403 &&
      (body as { code?: unknown } | null)?.code === TERMS_REQUIRED_CODE
    )
      window.dispatchEvent(new Event(TERMS_REQUIRED_EVENT))
    throw new ApiError(response.status, message, body)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
