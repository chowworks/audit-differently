import { generateKeyPairSync } from 'node:crypto'
import { dkimSign } from 'mailauth'
import { SenderCheck, addressesIn } from './sender-check'

/**
 * Our own sender check over a real DKIM signature (a key made for the test, its DNS answered by a fake resolver): DMARC
 * passes on the aligned signature; the To and Subject headers are counted; and only the recipients in a To or Cc
 * header that the signature covers count as the ones the sender vouched for.
 */
const DOMAIN = 'bright-path.example.org'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const p = publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString()
  .replace(/-----[^-]+-----|\s/g, '')
const resolver = async (name: string, type: string) => {
  if (type === 'TXT' && name === `sel._domainkey.${DOMAIN}`) return [[`v=DKIM1; k=rsa; p=${p}`]]
  if (type === 'TXT' && name === `_dmarc.${DOMAIN}`) return [['v=DMARC1; p=reject']]
  throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
}

const message = (headers: string[]) =>
  Buffer.from(
    [
      `From: Pat Bookkeeper <bookkeeper@${DOMAIN}>`,
      ...headers,
      'Date: Sun, 20 Sep 2026 15:00:00 +0000',
      'Message-ID: <fictional-1@bright-path.example.org>',
      '',
      'A fictional receipt.',
      '',
    ].join('\r\n')
  )
const sign = async (raw: Buffer, headerList?: string) => {
  const r = await dkimSign(raw, {
    ...(headerList && { headerList }),
    signatureData: [
      {
        signingDomain: DOMAIN,
        selector: 'sel',
        privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }),
      },
    ],
  } as never)
  return Buffer.concat([Buffer.from(r.signatures), raw])
}

describe('SenderCheck', () => {
  const check = new SenderCheck()

  it('reads the addresses of a header line', () => {
    expect(addressesIn('To: Pat <Pat@Example.org>, lee@example.org;\r\n\tx@y.example.org')).toEqual(
      ['pat@example.org', 'lee@example.org', 'x@y.example.org']
    )
  })

  it('passes a message signed by the From domain, and names the signed recipients', async () => {
    const raw = await sign(
      message(['To: bright-path@receipts.example.org', 'Cc: lee@example.org', 'Subject: CP26'])
    )
    const v = await check.verify(raw, 'receipts.example.org', resolver)
    expect(v).toEqual({
      dmarcPass: true,
      headerFrom: [`bookkeeper@${DOMAIN}`],
      toHeaders: 1,
      subjectHeaders: 1,
      signedRecipients: ['bright-path@receipts.example.org', 'lee@example.org'],
    })
  })

  it('names no recipient a signature does not cover', async () => {
    const raw = await sign(
      message(['To: bright-path@receipts.example.org', 'Subject: CP26']),
      'From:Subject:Date'
    )
    const v = await check.verify(raw, 'receipts.example.org', resolver)
    expect(v.dmarcPass).toBe(true)
    expect(v.signedRecipients).toEqual([])
  })

  it('counts a To or Subject header added after signing', async () => {
    const signed = await sign(message(['To: someone@elsewhere.example.org', 'Subject: Lunch']))
    const replayed = Buffer.concat([
      Buffer.from('To: bright-path@receipts.example.org\r\nSubject: CP26\r\n'),
      signed,
    ])
    const v = await check.verify(replayed, 'receipts.example.org', resolver)
    expect([v.toHeaders, v.subjectHeaders]).toEqual([2, 2])
    expect(v.signedRecipients).not.toContain('bright-path@receipts.example.org')
  })

  it('does not pass a message whose signature does not hold', async () => {
    const raw = await sign(message(['To: bright-path@receipts.example.org', 'Subject: CP26']))
    const changed = Buffer.from(raw.toString().replace('A fictional receipt.', 'Another body.'))
    const v = await check.verify(changed, 'receipts.example.org', resolver)
    expect(v.dmarcPass).toBe(false)
    expect(v.signedRecipients).toEqual([])
  })
})
