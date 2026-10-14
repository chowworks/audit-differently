import { useUser } from '@clerk/clerk-react'
import { PLATFORM_ADMIN } from '@ad/types'

/**
 * Clerk `publicMetadata.role`: `isAdmin` is the platform admin (Admin tools). Only decides what to show; the API asks
 * Clerk itself on every admin request and never trusts this. Same convention as Interview Differently.
 */
export function useRole() {
  const { user } = useUser()
  const isAdmin = user?.publicMetadata?.role === PLATFORM_ADMIN
  return { role: isAdmin ? PLATFORM_ADMIN : null, isAdmin }
}
