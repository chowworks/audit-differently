import { BadRequestException } from '@nestjs/common'
import { EngagementsController } from './engagements.controller'
import { parseEngagementBody, parseParticipantBody, parseReportBody } from './engagement-body'

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
  const engagements = {
    create: jest.fn(),
    update: jest.fn(),
    createReport: jest.fn(),
    createParticipant: jest.fn(),
  }
  const callers = { load: jest.fn().mockResolvedValue({}) }
  return {
    controller: new EngagementsController(engagements as never, {} as never, callers as never),
    engagements,
  }
}

describe('engagement request bodies', () => {
  it('answers a participant number sent as a number with a 400, not a 500 (issue #107)', async () => {
    const { controller: c, engagements } = controller()
    const body = { participantId: 123, displayName: 'Riley Example' }
    expect(await refusal(() => c.createParticipant('u', 'e-1', body))).toBe(
      'participantId must be text'
    )
    expect(engagements.createParticipant).not.toHaveBeenCalled()
  })

  it('refuses every wrong type of a new engagement in one message', async () => {
    const { controller: c, engagements } = controller()
    const body = { workspaceId: 'w-1', kind: 'grant', name: 7, funder: ['x'], awardAmount: {} }
    expect(await refusal(() => c.create('u', body))).toBe(
      'name must be text. funder must be text. awardAmount must be a number'
    )
    expect(engagements.create).not.toHaveBeenCalled()
  })

  it('refuses a missing or wrong body on each route', async () => {
    const { controller: c } = controller()
    expect(await refusal(() => c.createReport('u', 'e-1', null))).toBe('period is required')
    expect(await refusal(() => c.createReport('u', 'e-1', { period: 202610 }))).toBe(
      'period must be text'
    )
    expect(await refusal(() => c.update('u', 'e-1', 'text'))).toBe(
      'The request body must be a JSON object'
    )
    expect(await refusal(() => c.create('u', undefined))).toBe(
      'workspaceId is required. kind is required. name is required'
    )
  })

  it('names a wrong tag type with the other problems, so one try shows them all', async () => {
    const { controller: c, engagements } = controller()
    expect(await refusal(() => c.update('u', 'e-1', { name: 7, tags: [1] }))).toBe(
      'name must be text. tags must be a list of text'
    )
    expect(
      await refusal(() =>
        c.createParticipant('u', 'e-1', { participantId: 1, displayName: 'A', tags: 'x' })
      )
    ).toBe('participantId must be text. tags must be a list of text')
    expect(engagements.update).not.toHaveBeenCalled()
    expect(engagements.createParticipant).not.toHaveBeenCalled()
  })

  it('refuses a checklist item of the wrong type rather than saving it changed', async () => {
    const { controller: c, engagements } = controller()
    // cleanEligibilityItems would save this as a required item named "123".
    const items = [
      { label: 123, required: 'false' },
      { label: 'Form', key: 5 },
    ]
    expect(await refusal(() => c.update('u', 'e-1', { eligibilityItems: items }))).toBe(
      'eligibilityItems[0].label must be text. eligibilityItems[0].required must be true or false. ' +
        'eligibilityItems[1].key must be text'
    )
    for (const eligibilityItems of [null, 'x', { label: 'Form' }])
      expect(await refusal(() => c.update('u', 'e-1', { eligibilityItems }))).toBe(
        'eligibilityItems must be a list'
      )
    // An item that is not an object is named on its own, and the items around it are still checked.
    expect(
      await refusal(() =>
        c.update('u', 'e-1', {
          eligibilityItems: [{ label: 123 }, 'Form', null, [], { label: 'ID' }],
        })
      )
    ).toBe(
      'eligibilityItems[0].label must be text. eligibilityItems[1] must be an object. ' +
        'eligibilityItems[2] must be an object. eligibilityItems[3] must be an object'
    )
    expect(engagements.update).not.toHaveBeenCalled()
  })

  it('leaves out of a checklist item what it leaves out, so the defaults still apply', () => {
    const eligibilityItems = [
      { label: 'Enrollment form' },
      { key: '', label: 'ID', required: true },
    ]
    expect(parseEngagementBody({ eligibilityItems }, true)).toEqual({ eligibilityItems })
  })

  it('passes the bodies the web app sends to the service', async () => {
    const { controller: c, engagements } = controller()
    await c.createParticipant('u', 'e-1', { participantId: '900002', displayName: 'Riley' })
    expect(engagements.createParticipant).toHaveBeenCalledWith({}, 'e-1', {
      participantId: '900002',
      displayName: 'Riley',
      enrollmentStatus: undefined,
      tags: undefined,
    })
    await c.createReport('u', 'e-1', { period: '2026-10' })
    expect(engagements.createReport).toHaveBeenCalledWith({}, 'e-1', '2026-10')
  })

  it('keeps only the fields a change has, so the update changes only those', () => {
    expect(parseEngagementBody({ code: ' cp-26 ', workspaceId: 'other' }, true)).toEqual({
      code: ' cp-26 ',
    })
    // The Details modal: empty dates, null amounts, a number for the due day, the checklist and tags as they are.
    const save = {
      kind: 'grant',
      name: 'Coding Pathway',
      periodStart: '',
      awardAmount: null,
      requestedAmount: '50000',
      reportDueDay: 12,
      tracks: ['proposal'],
      waivers: { proposal: 'invited directly' },
      tags: ['funding-source:youth-workforce-fund'],
      eligibilityItems: [{ label: 'Enrollment form' }],
    }
    expect(parseEngagementBody(save, true)).toEqual(save)
  })

  it('reads the report and participant bodies', () => {
    expect(parseReportBody({ period: '2026-10' })).toEqual({ period: '2026-10' })
    expect(
      parseParticipantBody({
        participantId: '1',
        displayName: 'A',
        enrollmentStatus: null,
        tags: ['t'],
      })
    ).toEqual({ participantId: '1', displayName: 'A', enrollmentStatus: undefined, tags: ['t'] })
  })
})
