import {
  InboundConfirmation,
  confirmationConfig,
  confirmationEmail,
  isOwnConfirmation,
  type Confirmation,
} from './confirmation'

/** Issue #82: the confirmation says where the files went and links to fix it, and carries nothing of the files. */
const APP = 'https://app.example.org'
const base: Confirmation = {
  to: 'bookkeeper@bright-path.example.org',
  outcome: 'filed',
  receivedAt: new Date('2026-11-17T01:40:00Z'),
  workspaceId: 'ws-1',
  owner: true,
  kind: 'timesheet',
  period: '2026-10',
  engagementName: null,
  filed: 2,
  alreadyOnFile: 0,
  periods: [],
  reportId: null,
  skipped: 0,
  reason: null,
}

describe('confirmationEmail', () => {
  it("names the folder and month, in the East Coast's time, and links an owner to Month End Close", () => {
    const { subject, text } = confirmationEmail(base, APP)
    expect(subject).toBe('Filed: 2 timesheets for October 2026')
    expect(text).toContain('your email of November 16, 2026 at 8:40 PM')
    expect(text).toContain("Where: Timesheets, October 2026, in Month End Close's File Management.")
    expect(text).toContain(`${APP}/workspaces/ws-1/payroll?period=2026-10`)
    expect(text).toContain('timesheets, registers, paystubs, statements, quickbooks')
  })

  it('links anyone else to the inbox they can read', () => {
    const { text } = confirmationEmail({ ...base, owner: false }, APP)
    expect(text).toContain(`${APP}/workspaces/ws-1#receipts`)
    expect(text).not.toContain('/payroll')
  })

  it("links a receipt to its month's page, with the engagement", () => {
    const { subject, text } = confirmationEmail(
      {
        ...base,
        kind: 'receipt',
        period: null,
        engagementName: 'Coding Pathway',
        filed: 1,
        periods: ['2026-09'],
        reportId: 'r-1',
      },
      APP
    )
    expect(subject).toBe('Filed: 1 receipt in Coding Pathway')
    expect(text).toContain('Where: Coding Pathway, September 2026')
    expect(text).toContain(`${APP}/reports/r-1`)
  })

  it("puts a receipt filed to no engagement in Month End Close's Receipts, and links an owner there", () => {
    const receipt = {
      ...base,
      kind: 'receipt' as const,
      period: null,
      engagementName: null,
      filed: 1,
      periods: ['2026-10'],
      reportId: null,
    }
    const { subject, text } = confirmationEmail(receipt, APP)
    expect(subject).toBe('Filed: 1 receipt for October 2026')
    expect(isOwnConfirmation(subject)).toBe(true)
    expect(text).toContain(
      "Where: Receipts, October 2026, in Month End Close. An owner matches it to the books' bills."
    )
    expect(text).toContain(`${APP}/workspaces/ws-1/payroll?period=2026-10`)
    expect(text).not.toContain('/reports/')
    // Anyone else: the inbox they can read.
    const other = confirmationEmail({ ...receipt, owner: false }, APP).text
    expect(other).toContain(`${APP}/workspaces/ws-1#receipts`)
    expect(other).not.toContain('/payroll')
    // Two receipts, one on file already; then every one on file.
    expect(confirmationEmail({ ...receipt, filed: 1, alreadyOnFile: 1 }, APP).text).toContain(
      "An owner matches them to the books' bills.\n1 receipt was already on file in Receipts."
    )
    const none = confirmationEmail({ ...receipt, filed: 0, alreadyOnFile: 2 }, APP)
    expect(none.subject).toBe('Already on file: 2 receipts for October 2026')
    expect(isOwnConfirmation(none.subject)).toBe(true)
  })

  it('says why it waits, and what could not be filed', () => {
    expect(
      confirmationEmail(
        { ...base, outcome: 'unmatched', reason: 'The subject names more than one month' },
        APP
      ).text
    ).toContain('go: The subject names more than one month.')
    expect(confirmationEmail({ ...base, outcome: 'nothing', reason: 'x' }, APP).text).toContain(
      'Timesheets takes PDF, PNG, JPG, XLSX, DOCX, CSV files.'
    )
  })
})

describe('files already on file', () => {
  it('counts only the files kept new, and says which were on file already', () => {
    const { subject, text } = confirmationEmail(
      { ...base, kind: 'payroll-register', filed: 2, alreadyOnFile: 1 },
      APP
    )
    expect(subject).toBe('Filed: 2 payroll registers for October 2026')
    expect(text).toContain('We filed 2 files from your email')
    expect(text).toContain('1 file was already on file in Payroll registers.')
  })

  it('says so when every file was on file already, and claims nothing filed', () => {
    const { subject, text } = confirmationEmail({ ...base, filed: 0, alreadyOnFile: 2 }, APP)
    expect(subject).toBe('Already on file: 2 timesheets for October 2026')
    expect(text).toContain('was already on file, so nothing new was kept')
    expect(text).not.toContain('We filed')
    expect(text).not.toContain('Re-match')
  })
})

describe('isOwnConfirmation', () => {
  it('knows each of our subjects, also under a reply or forward', () => {
    for (const c of [
      base,
      { ...base, filed: 0, alreadyOnFile: 1 },
      { ...base, kind: 'receipt' as const, engagementName: 'Coding Pathway', periods: ['2026-09'] },
      { ...base, outcome: 'unmatched' as const },
      { ...base, outcome: 'nothing' as const },
    ]) {
      const { subject } = confirmationEmail(c, APP)
      expect([subject, isOwnConfirmation(subject)]).toEqual([subject, true])
      expect(isOwnConfirmation(`Automatic reply: ${subject}`)).toBe(true)
      expect(isOwnConfirmation(`RE: ${subject}`)).toBe(true)
    }
  })

  it("leaves a person's own subjects alone", () => {
    for (const s of ['Timesheets October', 'Receipt CP26', 'Filed taxes receipt', null])
      expect(isOwnConfirmation(s)).toBe(false)
  })
})

describe('InboundConfirmation.send', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
    jest.restoreAllMocks()
  })

  it('marks the email Auto-Submitted, so no automatic reply comes back', async () => {
    process.env.RESEND_API_KEY = 're_test_fictional'
    process.env.RECEIPTS_REPLY_FROM = 'Audit <no-reply@x.example.org>'
    process.env.FRONTEND_URL = APP
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await new InboundConfirmation().send(base)
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      to: [base.to],
      headers: { 'Auto-Submitted': 'auto-generated' },
    })
    expect(body).not.toHaveProperty('attachments')
  })
})

describe('confirmationConfig', () => {
  it('is off unless the key, the from address and an exact app address are all set', () => {
    const env = { RESEND_API_KEY: 'k', RECEIPTS_REPLY_FROM: 'Audit <no-reply@x.example.org>' }
    expect(confirmationConfig(env)).toBeNull()
    expect(
      confirmationConfig({
        ...env,
        FRONTEND_URL: 'https://*.preview.example.org,https://app.example.org/',
      })
    ).toEqual({ key: 'k', from: 'Audit <no-reply@x.example.org>', app: 'https://app.example.org' })
    expect(confirmationConfig({ FRONTEND_URL: 'https://app.example.org' })).toBeNull()
  })

  it('takes the first https address over a laptop one, else the first exact one', () => {
    const env = { RESEND_API_KEY: 'k', RECEIPTS_REPLY_FROM: 'no-reply@x.example.org' }
    expect(
      confirmationConfig({
        ...env,
        FRONTEND_URL: 'http://localhost:5273,https://app.example.org,https://two.example.org',
      })?.app
    ).toBe('https://app.example.org')
    expect(confirmationConfig({ ...env, FRONTEND_URL: 'http://localhost:5273' })?.app).toBe(
      'http://localhost:5273'
    )
  })
})
