import { createContext, useContext, useMemo } from 'react'
import { ClerkProvider, useAuth, useUser } from '@clerk/clerk-react'

/** The signed-in person, from Clerk: the only way in, in every environment. Pages read it through useSession. */
export interface Session {
  ready: boolean
  signedIn: boolean
  displayName: string
  /** The person's own name and email, for forms that would otherwise ask (empty when unknown). */
  name: string
  email: string
  getToken: () => Promise<string | null>
}

const SessionContext = createContext<Session | null>(null)

export function useSession(): Session {
  const s = useContext(SessionContext)
  if (!s) throw new Error('useSession outside a SessionProvider')
  return s
}

function ClerkSession({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const { user } = useUser()
  const value = useMemo<Session>(
    () => ({
      ready: isLoaded,
      signedIn: !!isSignedIn,
      displayName: user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? '',
      name: user?.fullName ?? '',
      email: user?.primaryEmailAddress?.emailAddress ?? '',
      getToken: () => getToken(),
    }),
    [isLoaded, isSignedIn, user, getToken]
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
  if (!key || key === 'pk_test_replace_me') {
    throw new Error(
      'Missing VITE_CLERK_PUBLISHABLE_KEY: add the dev Clerk instance key to apps/web/.env.local (DEVELOPMENT.md)'
    )
  }
  return (
    <ClerkProvider publishableKey={key}>
      <ClerkSession>{children}</ClerkSession>
    </ClerkProvider>
  )
}
