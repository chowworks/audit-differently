import { useEffect, useRef, useState } from 'react'
import type { AdminUserDto } from '@ad/types'
import { useApi } from '@/hooks/useApi'

/**
 * Platform admins only (`GET /admin/users`, AdminGuard): the people who match `query`, searched as the admin types, a
 * moment after the last key; an answer to an older query is dropped. `found` is null while the query is empty, and an
 * error stays until the query changes.
 */
export function usePeopleSearch(query: string) {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [found, setFound] = useState<AdminUserDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const q = query.trim()
    setError(null)
    if (!q) {
      setFound(null)
      return
    }
    let current = true
    const timer = setTimeout(async () => {
      try {
        const people = await apiRef.current.get<AdminUserDto[]>(
          `/admin/users?q=${encodeURIComponent(q)}`
        )
        if (current) setFound(people)
      } catch (e) {
        if (!current) return
        setFound(null)
        setError((e as Error).message)
      }
    }, 300)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query])
  return { found, error }
}
