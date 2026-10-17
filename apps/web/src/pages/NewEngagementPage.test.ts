import { describe, expect, it } from 'vitest'
import type { EngagementInput } from '@ad/types'
import { engagementBody } from './NewEngagementPage'

const form: EngagementInput = {
  workspaceId: 'w1',
  kind: 'grant',
  name: 'Summer Youth Works',
  solicitation: 'RFP-0000',
  funder: 'Example Workforce Board',
  funderContact: 'grants@example.org',
  tags: ['funding-source:source-a'],
  requestedAmount: 50000,
  proposalSubmittedOn: '2026-01-15',
  awardedOn: '2026-03-01',
  awardAmount: 45000,
}

describe('the new engagement as posted', () => {
  it('sends every field when both steps are kept', () => {
    const b = engagementBody(form, 'grant', ['proposal', 'award-letter'])
    expect(b).toMatchObject({
      solicitation: 'RFP-0000',
      requestedAmount: 50000,
      awardedOn: '2026-03-01',
    })
  })

  it('leaves out the fields of a step that is not kept, and keeps the funder and amount', () => {
    const b = engagementBody(form, 'grant', [])
    for (const k of ['solicitation', 'requestedAmount', 'proposalSubmittedOn', 'awardedOn'])
      expect(b).not.toHaveProperty(k)
    expect(b).toMatchObject({
      funder: 'Example Workforce Board',
      funderContact: 'grants@example.org',
      tags: ['funding-source:source-a'],
      awardAmount: 45000,
    })
    // The budget is entered on the engagement, from Manage Budget: nothing is picked at setup.
    expect(b).not.toHaveProperty('budgetItems')
  })
})
