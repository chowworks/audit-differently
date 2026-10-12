import { describe, expect, it } from 'vitest'
import { termsGateCopy } from './termsGateCopy'

describe('termsGateCopy', () => {
  it('asks a first-time person to read and accept', () => {
    expect(termsGateCopy(false)).toEqual({
      heading: 'Terms & Conditions',
      intro: 'Please read and accept the Terms & Conditions to continue.',
    })
  })

  it('tells a returning person the Terms were updated', () => {
    expect(termsGateCopy(true)).toEqual({
      heading: 'Our Terms & Conditions have been updated',
      intro: 'Please read the updated Terms & Conditions and accept them to continue.',
    })
  })
})
