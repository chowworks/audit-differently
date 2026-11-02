import { corsOrigin, frontendOriginCheck, frontendOrigins } from './cors'

describe('FRONTEND_URL origins', () => {
  const dev =
    'http://localhost:5173, https://audit-differently-git-*-ludakhris-projects.vercel.app,https://app.example.test'
  const allowed = frontendOriginCheck(dev)

  it('keeps exact addresses exact', () => {
    expect(allowed('http://localhost:5173')).toBe(true)
    expect(allowed('https://app.example.test')).toBe(true)
    expect(allowed('https://app.example.test.evil.com')).toBe(false)
    expect(allowed('http://localhost:5174')).toBe(false)
  })

  it('lets a pattern match any branch preview, and nothing beyond it', () => {
    expect(
      allowed('https://audit-differently-git-payroll-original-files-ludakhris-projects.vercel.app')
    ).toBe(true)
    expect(allowed('https://audit-differently-git-x.evil.com-ludakhris-projects.vercel.app')).toBe(
      false
    )
    expect(allowed('https://evil.com/audit-differently-git-x-ludakhris-projects.vercel.app')).toBe(
      false
    )
    expect(allowed('http://audit-differently-git-x-ludakhris-projects.vercel.app')).toBe(false)
    expect(allowed('https://audit-differently-git-x-ludakhris-projects.vercel.app.evil.com')).toBe(
      false
    )
    expect(allowed('https://audit-differently-git--ludakhris-projects.vercel.app')).toBe(false)
    expect(allowed('https://other-git-x-ludakhris-projects.vercel.app')).toBe(false)
  })

  it('refuses a * anywhere but the first part of an https address', () => {
    expect(() => frontendOrigins('https://*.vercel.app.*')).toThrow()
    expect(() => frontendOrigins('http://*-preview.example.com')).toThrow()
    expect(() => frontendOrigins('https://app.*.vercel.app')).toThrow()
  })

  it('answers CORS from the same list', () => {
    const check = corsOrigin(dev)
    const answer = (origin: string | undefined) => {
      let result: boolean | undefined
      check(origin, (_err, allow) => (result = allow))
      return result
    }
    expect(answer('https://audit-differently-git-a-ludakhris-projects.vercel.app')).toBe(true)
    expect(answer('https://evil.vercel.app')).toBe(false)
    expect(answer(undefined)).toBe(true)
  })
})
