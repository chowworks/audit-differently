import { ArgumentsHost, Catch, ConflictException } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { Prisma } from '@prisma/client'

/** The database refused a change to a closed or submitted month (trigger `month_is_draft`, migration 20261015001100). */
export const isMonthLocked = (e: unknown): boolean =>
  e instanceof Error && e.message.includes('month_locked:')

export const MONTH_LOCKED_MESSAGE =
  'This month is closed or submitted, so its ledger can no longer change; send its month-end closing back to change it'

/**
 * The month lock's refusal from the database, as the API's own 409: the API checks the month first
 * (`ReportsService.editable`), so this is the change that raced a closing being approved. Every other error goes on
 * to Nest's own handling unchanged.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientUnknownRequestError)
export class MonthLockedFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    super.catch(
      isMonthLocked(exception) ? new ConflictException(MONTH_LOCKED_MESSAGE) : exception,
      host
    )
  }
}
