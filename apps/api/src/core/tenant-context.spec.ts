import { contextMarks } from '../prisma/prisma.service'
import {
  identifyAdmin,
  identifyCaller,
  runAsSystem,
  tenantContext,
  withTenantContext,
} from './tenant-context'

/** When the platform admin's mark (app.admin) is set, and every way it is turned off. */
describe('the admin mark', () => {
  it('is set for a verified caller AdminGuard marked, beside their own id and never with the system mark', () => {
    withTenantContext(() => {
      identifyCaller({ userId: 'user_admin' })
      identifyAdmin()
      expect(contextMarks(tenantContext()!)).toEqual({ system: '', admin: 'on' })
    })
  })

  it('is off inside runAsSystem, even nested in an admin request', () => {
    withTenantContext(() => {
      identifyCaller({ userId: 'user_admin' })
      identifyAdmin()
      runAsSystem(() => {
        expect(tenantContext()).toEqual({ allWorkspaces: true })
        expect(contextMarks(tenantContext()!)).toEqual({ system: 'on', admin: '' })
      })
    })
    // A context that somehow carried both would still set only the system mark.
    expect(contextMarks({ userId: 'u', admin: true, allWorkspaces: true }).admin).toBe('')
  })

  it('is reset by identifyCaller', () => {
    withTenantContext(() => {
      identifyCaller({ userId: 'user_admin' })
      identifyAdmin()
      identifyCaller({ userId: 'user_admin' })
      expect(tenantContext()?.admin).toBe(false)
      expect(contextMarks(tenantContext()!).admin).toBe('')
    })
  })

  it('is not set by identifyAdmin without a verified caller', () => {
    withTenantContext(() => {
      identifyAdmin()
      expect(tenantContext()?.admin).toBeUndefined()
      expect(contextMarks(tenantContext()!).admin).toBe('')
    })
    // Nor outside a request.
    expect(() => identifyAdmin()).not.toThrow()
    expect(tenantContext()).toBeUndefined()
  })
})
