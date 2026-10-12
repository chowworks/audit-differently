import { HealthController, environmentName } from './health.controller'

describe('environmentName', () => {
  it('uses the Railway environment name when there is one', () => {
    expect(environmentName({ RAILWAY_ENVIRONMENT_NAME: 'dev', NODE_ENV: 'development' })).toBe(
      'dev'
    )
  })
  it('falls back to production or local from NODE_ENV', () => {
    expect(environmentName({ NODE_ENV: 'production' })).toBe('production')
    expect(environmentName({})).toBe('local')
  })
})

describe('HealthController', () => {
  it('reports the environment', () => {
    expect(new HealthController().check()).toMatchObject({
      status: 'ok',
      environment: expect.any(String),
    })
  })
  it('says nothing about configuration: four plain fields and no more', () => {
    expect(Object.keys(new HealthController().check()).sort()).toEqual([
      'environment',
      'status',
      'timestamp',
      'version',
    ])
  })
})
