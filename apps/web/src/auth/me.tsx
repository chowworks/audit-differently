import { createContext, useContext } from 'react'

/** The version of the Terms now in force, as GET /me says; the app sends it back when someone accepts the Terms. It never works one out. */
const TermsVersionContext = createContext<string>('')
export const TermsVersionProvider = TermsVersionContext.Provider
export const useTermsVersion = () => useContext(TermsVersionContext)
