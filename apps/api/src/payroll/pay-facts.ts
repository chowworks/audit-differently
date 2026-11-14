import type { PayLineKind, StatementLine } from '@ad/types'
import { amountsOn, bankDates, netOnRow, registerLayout, type PayRun } from './pay-runs'
import { registerPerson, type StubReading } from './staff-match'

/** A person-pay's amount, date and payee, as the reconciliation's Date, Amount and Paid columns show them. */
export interface PayFacts {
  amount: number | null
  /** yyyy-mm-dd. */
  payDate: string | null
  payee: string | null
}

/** The one amount a line prints; none when it prints several (an amount and a balance can't be told apart). */
const oneAmount = (text: string) => {
  const all = amountsOn(text)
  return all.length === 1 ? all[0]! : null
}

/**
 * What a person-pay is (owner's decision, 2026-11-14), never guessed:
 * - a pay stub: its net pay (else its gross), as a register row and a bank line show the pay sent; its pay period's end (else its pay date) and the name it prints;
 * - a register row: its net, by the register's heading (else the one amount it prints), its run's pay date (else the
 *   pay period's end) and the person it names;
 * - a bank line: the one amount it prints and its date.
 * Given only the kept line (a pay saved before these were kept), what that line alone says.
 */
export function payFactsOf(input: {
  kind: PayLineKind
  line: StatementLine | null
  period: string
  /** The file's lines, when it is read now (a match). */
  fileLines?: StatementLine[]
  /** A register's pay run. */
  run?: Pick<PayRun, 'payDate' | 'end'> | null
  /** A pay stub's reading. */
  stub?: { reading: StubReading; named: string | null } | null
}): PayFacts {
  const { kind, line, stub, run } = input
  const text = line?.text ?? ''
  if (kind === 'paystub') {
    if (stub)
      return {
        amount: stub.reading.net ?? stub.reading.gross,
        payDate: stub.reading.end ?? stub.reading.payDate,
        payee: stub.named,
      }
    return { amount: line ? oneAmount(text) : null, payDate: null, payee: null }
  }
  if (!line) return { amount: null, payDate: null, payee: null }
  if (kind === 'payroll-register')
    return {
      amount:
        (input.fileLines ? netOnRow(text, registerLayout(input.fileLines)) : null) ??
        oneAmount(text),
      payDate: run?.payDate ?? run?.end ?? null,
      payee: registerPerson(text)?.name ?? null,
    }
  return {
    amount: oneAmount(text),
    payDate: bankDates(text, Number(input.period.slice(0, 4)))[0] ?? null,
    payee: null,
  }
}
