import { authorizedParty, verifiedEmail } from './clerk.service'

const addr = (id: string, emailAddress: string, status: string | null) => ({
  id,
  emailAddress,
  verification: status ? { status } : null,
})

describe('verifiedEmail', () => {
  it('takes the primary address when it is verified', () => {
    expect(
      verifiedEmail({
        primaryEmailAddressId: 'a',
        emailAddresses: [
          addr('a', 'me@example.test', 'verified'),
          addr('b', 'x@example.test', 'verified'),
        ],
      })
    ).toBe('me@example.test')
  })

  it('falls back to the first verified address when no primary is set', () => {
    expect(
      verifiedEmail({
        primaryEmailAddressId: null,
        emailAddresses: [
          addr('a', 'u@example.test', 'unverified'),
          addr('b', 'v@example.test', 'verified'),
        ],
      })
    ).toBe('v@example.test')
  })

  it('never uses an unverified address, primary or not', () => {
    expect(
      verifiedEmail({
        primaryEmailAddressId: 'a',
        emailAddresses: [addr('a', 'claim@provider.example', 'unverified')],
      })
    ).toBeNull()
    expect(verifiedEmail({ primaryEmailAddressId: null, emailAddresses: [] })).toBeNull()
  })
})

describe('authorizedParty', () => {
  const list = 'http://localhost:5173,https://audit-differently-git-*-ludakhris-projects.vercel.app'

  it('accepts a token made on a FRONTEND_URL address or a branch preview', () => {
    expect(authorizedParty('http://localhost:5173', list)).toBe(true)
    expect(
      authorizedParty('https://audit-differently-git-a-ludakhris-projects.vercel.app', list)
    ).toBe(true)
  })

  it('refuses a token made elsewhere, or with no azp', () => {
    expect(authorizedParty('https://evil.vercel.app', list)).toBe(false)
    expect(authorizedParty(undefined, list)).toBe(false)
    expect(authorizedParty('', list)).toBe(false)
  })
})
