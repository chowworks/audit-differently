import type { StatementLine } from '@ad/types'

/** Rows as `sheetLines` reads them: cells joined by " | ", column A first. A fictional company's month. */
export const rows = (...texts: string[]): StatementLine[] =>
  texts.map((text, i) => ({ page: 1, x: 0, y: i + 1, width: 1, height: 1, text }))

export const BOOKS = rows(
  'Riverbend Learning',
  'Transaction List with Splits',
  ' | Transaction date | Transaction type | Num | Posting (Y/N) | Name | Class full name | Description | Account Name | Amount | Transaction ID',
  '11000 Accounts Receivable',
  // An invoice: income, never an expense.
  ' | 09/01/2026 | Invoice | 1001 | Yes | Harbor County |  |  | 11000 Accounts Receivable | 500 | 9001',
  ' | 09/01/2026 | Invoice | 1001 | Yes | Harbor County | Youth Coding Program |  | 40000 Program Income | 500 | 9001',
  // Rent paid from the bank, split by class.
  ' | 09/02/2026 | Expense |  | Yes | Maple Properties |  | RENT SEPT | 10000 Lakeside Checking 1234 | -1000 | 9002',
  ' | 09/02/2026 | Expense |  | Yes | Maple Properties | Youth Coding Program | RENT SEPT | 60000 G&A:60901 Rent Expense | 600 | 9002',
  ' | 09/02/2026 | Expense |  | Yes | Maple Properties | Adult Bootcamp |  | 60000 G&A:60901 Rent Expense | 400 | 9002',
  // Software on the card, all one program's.
  ' | 09/05/2026 | Expense |  | Yes | Pixel Tools |  | PIXEL TOOLS XXXX1111 | 22000 Card:22001 Morgan Lee - Card | 80 | 9003',
  ' | 09/05/2026 | Expense |  | Yes | Pixel Tools | Youth Coding Program | PIXEL TOOLS XXXX1111 | 60301 Software and Subscription | 80 | 9003',
  // A payroll company bill held for allocation, then shared out at month end.
  ' | 09/08/2026 | Expense |  | Yes | PayPeople |  | BILL PAYPEOPLE | 10000 Lakeside Checking 1234 | -200 | 9004',
  ' | 09/08/2026 | Expense |  | Yes | PayPeople | Allocation Required | BILL PAYPEOPLE | 63301 Payroll Fees | 200 | 9004',
  ' | 09/30/2026 | Journal Entry | JE-7 | Yes |  | Allocation Required |  | 63301 Payroll Fees | -200 | 9005',
  ' | 09/30/2026 | Journal Entry | JE-7 | Yes |  | Youth Coding Program |  | 63301 Payroll Fees | 50 | 9005',
  ' | 09/30/2026 | Journal Entry | JE-7 | Yes |  | Adult Bootcamp |  | 63301 Payroll Fees | 150 | 9005',
  // A person's pay run: payroll's, never an expense.
  ' | 09/11/2026 | Journal Entry | 55 | Yes |  | Youth Coding Program | [PayPeople] Salary for Youth Coding Program jobs for Casey Demo. Payroll run: Aug 24th - Sep 6th | 63102 Salaries - Employees | 612.5 | 9006',
  ' | 09/11/2026 | Journal Entry | 55 | Yes |  |  | [PayPeople] Salary for Youth Coding Program jobs for Casey Demo. Payroll run: Aug 24th - Sep 6th | 24000 Payroll Liabilities | -612.5 | 9006',
  // A prepaid cost booked out of an asset: an expense with no payment of its own this month.
  ' | 09/30/2026 | Journal Entry | JE-8 | Yes |  | G&A |  | 60202 Insurance | 75 | 9007',
  ' | 09/30/2026 | Journal Entry | JE-8 | Yes |  |  |  | 13100 Prepaid Expenses | -75 | 9007',
  'Total for 11000 Accounts Receivable |  |  |  |  |  |  |  |  | 500'
)
