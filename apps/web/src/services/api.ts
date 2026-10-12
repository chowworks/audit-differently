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

/** Downloads a file from the API with the caller's token and hands it to the browser. */
export async function apiDownload(
  path: string,
  token: string | null,
  fileName: string
): Promise<void> {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_URL}/api${path}`, { headers })
  if (!response.ok)
    throw new ApiError(response.status, `Download failed (${response.status})`, null)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
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
    const message =
      (body &&
      typeof body === 'object' &&
      'message' in body &&
      typeof (body as { message: unknown }).message === 'string'
        ? (body as { message: string }).message
        : null) ?? `${init.method ?? 'GET'} ${path} failed (${response.status})`
    throw new ApiError(response.status, message, body)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
