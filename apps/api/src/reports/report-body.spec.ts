import { BadRequestException } from '@nestjs/common'
import { ReportsController } from './reports.controller'
import { parseExpenseBody } from './report-body'

/** The message of the 400 that `run` throws. */
async function refusal(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException)
    return ((e as BadRequestException).getResponse() as { message: string }).message
  }
  throw new Error('the body was not refused')
}

/** A controller whose service must never be reached by a body of the wrong type. */
function controller() {
  const reports = {
    addExpense: jest.fn(),
    updateExpense: jest.fn(),
    attachToExpense: jest.fn(),
    addWexPayment: jest.fn(),
    updateWexPayment: jest.fn(),
    attachToWex: jest.fn(),
    approveClosing: jest.fn(),
    sendBack: jest.fn(),
    requestEdits: jest.fn(),
    reopen: jest.fn(),
  }
  const callers = { load: jest.fn().mockResolvedValue({}) }
  return {
    controller: new ReportsController(reports as never, {} as never, callers as never),
    reports,
  }
}

/** An expense as the web app's expense form sends it. */
const expense = {
  itemNumber: '2105',
  date: '2026-10-03',
  vendor: 'Demo Office Supply',
  memo: '',
  account: '',
  totalCost: 120.5,
  allocatedAmount: 120.5,
  allocationType: 'direct',
  allocationNote: '',
  budgetLineId: 'b-1',
  tags: [],
}

describe('report request bodies', () => {
  it('answers an item number sent as a number with a 400, not a 500', async () => {
    const { controller: c, reports } = controller()
    expect(await refusal(() => c.addExpense('u', 'r-1', { ...expense, itemNumber: 2105 }))).toBe(
      'itemNumber must be text'
    )
    expect(reports.addExpense).not.toHaveBeenCalled()
  })

  it('refuses every wrong type of an expense in one message, on add and on edit', async () => {
    const { controller: c, reports } = controller()
    const body = { ...expense, vendor: 5, memo: [], totalCost: {}, tags: [1] }
    const message =
      'vendor must be text. memo must be text. totalCost must be a number. tags must be a list of text'
    expect(await refusal(() => c.addExpense('u', 'r-1', body))).toBe(message)
    expect(await refusal(() => c.updateExpense('u', 'x-1', body))).toBe(message)
    expect(await refusal(() => c.addExpense('u', 'r-1', null))).toBe(
      'itemNumber is required. date is required. vendor is required. totalCost is required. ' +
        'allocatedAmount is required. allocationType is required'
    )
    expect(reports.addExpense).not.toHaveBeenCalled()
    expect(reports.updateExpense).not.toHaveBeenCalled()
  })

  it('passes the expenses the web app sends, and keeps tags out of an edit that leaves them out', async () => {
    const { controller: c, reports } = controller()
    await c.addExpense('u', 'r-1', expense)
    expect(reports.addExpense).toHaveBeenCalledWith({}, 'r-1', expense)
    // An edit sends the expense as it was read, with fields the API does not take (id, documents...).
    const edit: Record<string, unknown> = {
      ...expense,
      id: 'x-1',
      memo: null,
      budgetLineId: null,
      documents: [],
    }
    delete edit.tags
    const parsed = parseExpenseBody(edit)
    expect(parsed).not.toHaveProperty('tags')
    expect(parsed).not.toHaveProperty('id')
    expect(parsed).toMatchObject({ memo: null, budgetLineId: null, itemNumber: '2105' })
    // Numbers as text still reach the service, which checks the amount.
    expect(parseExpenseBody({ ...expense, totalCost: '120.50' }).totalCost).toBe('120.50')
  })

  it('refuses a wrong document id or purpose on both attach routes', async () => {
    const { controller: c, reports } = controller()
    for (const attach of [c.attach, c.attachWex].map((f) => f.bind(c))) {
      expect(await refusal(() => attach('u', 'x-1', null))).toBe(
        'documentId is required. purpose is required'
      )
      expect(await refusal(() => attach('u', 'x-1', { documentId: 5, purpose: ['invoice'] }))).toBe(
        'documentId must be text. purpose must be text'
      )
    }
    expect(reports.attachToExpense).not.toHaveBeenCalled()
    expect(reports.attachToWex).not.toHaveBeenCalled()
    await c.attach('u', 'x-1', { documentId: 'd-1', purpose: 'invoice' })
    expect(reports.attachToExpense).toHaveBeenCalledWith({}, 'x-1', 'invoice', 'd-1')
  })

  it("refuses a work-experience payment's wrong types in one message, and passes the web app's", async () => {
    const { controller: c, reports } = controller()
    const wex = {
      participantId: 'p-1',
      payPeriodStart: '2026-10-01',
      payPeriodEnd: '2026-10-15',
      hours: null,
      grossAmount: 300,
      tags: [],
    }
    expect(
      await refusal(() => c.addWex('u', 'r-1', { ...wex, participantId: 1, hours: true }))
    ).toBe('participantId must be text. hours must be a number')
    expect(await refusal(() => c.updateWex('u', 'w-1', { ...wex, payPeriodEnd: 20261015 }))).toBe(
      'payPeriodEnd must be text'
    )
    expect(reports.addWexPayment).not.toHaveBeenCalled()
    expect(reports.updateWexPayment).not.toHaveBeenCalled()
    await c.addWex('u', 'r-1', wex)
    expect(reports.addWexPayment).toHaveBeenCalledWith({}, 'r-1', wex)
  })

  it('refuses a closing whose approver or note is not text, and passes the closing form', async () => {
    const { controller: c, reports } = controller()
    expect(
      await refusal(() =>
        c.approveClosing('u', 'r-1', { approvedBy: 5, approvedOn: '2026-10-31', note: {} })
      )
    ).toBe('approvedBy must be text. note must be text')
    expect(reports.approveClosing).not.toHaveBeenCalled()
    const form = { approvedBy: 'Dana Example', approvedOn: '2026-10-31', note: '' }
    await c.approveClosing('u', 'r-1', form)
    expect(reports.approveClosing).toHaveBeenCalledWith({}, 'r-1', form)
  })

  it('refuses a reason or comment that is not text, and leaves a missing one for the service to ask for', async () => {
    const { controller: c, reports } = controller()
    expect(await refusal(() => c.sendBack('u', 'r-1', { reason: 5 }))).toBe('reason must be text')
    expect(await refusal(() => c.reopen('u', 'r-1', { reason: ['x'] }))).toBe('reason must be text')
    expect(await refusal(() => c.requestEdits('u', 'r-1', { comment: true }))).toBe(
      'comment must be text'
    )
    expect(reports.sendBack).not.toHaveBeenCalled()
    expect(reports.reopen).not.toHaveBeenCalled()
    expect(reports.requestEdits).not.toHaveBeenCalled()
    // The service answers a missing reason with "Say why…", as before.
    await c.sendBack('u', 'r-1', {})
    expect(reports.sendBack).toHaveBeenCalledWith({}, 'r-1', '')
    await c.reopen('u', 'r-1', { reason: 'Corrected payroll' })
    expect(reports.reopen).toHaveBeenCalledWith({}, 'r-1', 'Corrected payroll')
    await c.requestEdits('u', 'r-1', { comment: 'Attach the invoice' })
    expect(reports.requestEdits).toHaveBeenCalledWith({}, 'r-1', 'Attach the invoice')
  })
})
