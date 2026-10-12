import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '@/auth/session'
import { apiDownload, apiFetch } from '@/services/api'

/** The API bound to the current session: get, post, patch, del and upload. */
export function useApi() {
  const { getToken } = useSession()
  return useMemo(() => {
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const token = await getToken()
      return apiFetch<T>(path, token, {
        method,
        body:
          body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      })
    }
    return {
      get: <T>(path: string) => call<T>('GET', path),
      post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
      patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body),
      del: <T>(path: string, body?: unknown) => call<T>('DELETE', path, body),
      upload: <T>(path: string, form: FormData) => call<T>('POST', path, form),
      download: async <T = never>(path: string, fileName: string) =>
        apiDownload<T>(path, await getToken(), fileName),
    }
  }, [getToken])
}

/** Loads `path` when it or the session changes; `reload` fetches it again in place. */
export function useLoad<T>(path: string | null) {
  const api = useApi()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!path)
  const version = useRef(0)
  const load = useCallback(async () => {
    if (!path) return
    const v = ++version.current
    setLoading(true)
    try {
      const d = await api.get<T>(path)
      if (v === version.current) {
        setData(d)
        setError(null)
      }
    } catch (e) {
      if (v === version.current) setError((e as Error).message)
    } finally {
      if (v === version.current) setLoading(false)
    }
  }, [api, path])
  useEffect(() => {
    void load()
  }, [load])
  return { data, error, loading, reload: load, setData }
}
