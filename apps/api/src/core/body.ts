import { BadRequestException } from '@nestjs/common'

/** One field of a request body that has the wrong type. */
export interface BodyProblem {
  field: string
  message: string
}

/** What a field may be besides its type: missing (`optional`) or `null` (`nullable`). */
interface Allow {
  optional?: boolean
  nullable?: boolean
}

/**
 * Reads a request body (`@Body() body: unknown`) and checks the type of each field it reads. It keeps every problem,
 * and `done()` refuses the request with all of them in one 400, so a wrong type never reaches a service as a
 * TypeError and a 500. It checks types only: the service still checks the values (a length, a pattern, a range).
 */
export class BodyReader {
  readonly problems: BodyProblem[] = []
  private readonly body: Record<string, unknown>

  constructor(input: unknown) {
    if (input === undefined || input === null) this.body = {}
    else if (typeof input === 'object' && !Array.isArray(input))
      this.body = input as Record<string, unknown>
    else {
      this.body = {}
      this.problems.push({ field: '', message: 'The request body must be a JSON object' })
    }
  }

  /** Whether the body has the field, even as `null`: a partial update changes only what it has. */
  has(field: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.body, field)
  }

  /** A field that is text. */
  string(field: string, allow?: Allow & { optional?: false; nullable?: false }): string
  string(field: string, allow: Allow): string | null | undefined
  string(field: string, allow: Allow = {}): string | null | undefined {
    return this.read(field, allow, 'text', (v) => typeof v === 'string') as
      string | null | undefined
  }

  /** A field that is a number, or text that the service turns into a number (`''` for none). */
  numberLike(field: string, allow: Allow = {}): number | string | null | undefined {
    return this.read(
      field,
      allow,
      'a number',
      (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
    ) as number | string | null | undefined
  }

  /** A field that is a list of text. */
  strings(field: string, allow: Allow = {}): string[] | null | undefined {
    return this.read(
      field,
      allow,
      'a list of text',
      (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')
    ) as string[] | null | undefined
  }

  /** A field that is an object whose values are text (or `null`). */
  textMap(field: string, allow: Allow = {}): Record<string, string | null> | null | undefined {
    return this.read(
      field,
      allow,
      'an object of text',
      (v) =>
        typeof v === 'object' &&
        v !== null &&
        !Array.isArray(v) &&
        Object.values(v).every((x) => x === null || typeof x === 'string')
    ) as Record<string, string | null> | null | undefined
  }

  /** A field as it was sent, for a caller that checks its type itself and reports with `problem()`. */
  any(field: string): unknown {
    return this.body[field]
  }

  /** A problem found by the caller (a field inside a list item), kept with the others for `done()`. */
  problem(field: string, message: string): void {
    this.problems.push({ field, message })
  }

  /** Refuses the request with every problem in one 400, or does nothing when there is none. */
  done(): void {
    if (this.problems.length)
      throw new BadRequestException({
        message: this.problems.map((p) => p.message).join('. '),
        problems: this.problems,
      })
  }

  private read(field: string, allow: Allow, type: string, ok: (v: unknown) => boolean): unknown {
    const v = this.body[field]
    if (v === undefined) {
      if (!allow.optional) this.problems.push({ field, message: `${field} is required` })
      return undefined
    }
    if (v === null) {
      if (!allow.nullable) this.problems.push({ field, message: `${field} must be ${type}` })
      return null
    }
    if (!ok(v)) {
      this.problems.push({ field, message: `${field} must be ${type}` })
      return undefined
    }
    return v
  }
}
