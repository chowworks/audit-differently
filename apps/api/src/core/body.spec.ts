import { BadRequestException } from '@nestjs/common'
import { BodyReader } from './body'

/** The 400 that done() throws, with its message and its problems. */
function refusal(r: BodyReader): { message: string; problems: unknown[] } {
  try {
    r.done()
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException)
    return (e as BadRequestException).getResponse() as { message: string; problems: unknown[] }
  }
  throw new Error('done() did not refuse the body')
}

describe('BodyReader', () => {
  it('reads fields of the right type and refuses nothing', () => {
    const r = new BodyReader({ name: 'A', amount: 5, tags: ['x'], waivers: { proposal: 'why' } })
    expect(r.string('name')).toBe('A')
    expect(r.numberLike('amount')).toBe(5)
    expect(r.strings('tags')).toEqual(['x'])
    expect(r.textMap('waivers')).toEqual({ proposal: 'why' })
    expect(() => r.done()).not.toThrow()
  })

  it('refuses every wrong type in one 400, field by field', () => {
    const r = new BodyReader({ name: 123, amount: true, tags: [1], waivers: [] })
    r.string('name')
    r.numberLike('amount')
    r.strings('tags')
    r.textMap('waivers')
    const { message, problems } = refusal(r)
    expect(message).toBe(
      'name must be text. amount must be a number. tags must be a list of text. waivers must be an object of text'
    )
    expect(problems).toEqual([
      { field: 'name', message: 'name must be text' },
      { field: 'amount', message: 'amount must be a number' },
      { field: 'tags', message: 'tags must be a list of text' },
      { field: 'waivers', message: 'waivers must be an object of text' },
    ])
  })

  it('refuses a missing or null field unless it is allowed', () => {
    const r = new BodyReader({ b: null, d: null })
    expect(r.string('a')).toBeUndefined()
    expect(r.string('b')).toBeNull()
    expect(r.string('c', { optional: true })).toBeUndefined()
    expect(r.string('d', { nullable: true })).toBeNull()
    expect(refusal(r).message).toBe('a is required. b must be text')
  })

  it('refuses a body that is not an object, and reads a missing body as empty', () => {
    for (const body of ['text', 5, [1]])
      expect(refusal(new BodyReader(body)).message).toBe('The request body must be a JSON object')
    const empty = new BodyReader(undefined)
    expect(empty.has('a')).toBe(false)
    expect(empty.string('a', { optional: true })).toBeUndefined()
    expect(() => empty.done()).not.toThrow()
  })

  it('refuses a number that is not finite', () => {
    const r = new BodyReader({ n: Number.NaN })
    r.numberLike('n')
    expect(refusal(r).message).toBe('n must be a number')
  })
})
