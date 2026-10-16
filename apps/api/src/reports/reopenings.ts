/**
 * A month's reopenings (ReportReopening, migration 20261015001500) and the signed copies they keep: which signed copy
 * counts for a month now, and how the exports name the earlier ones and list the reopenings.
 */

type SignedDoc = { kind: string; period: string | null; uploadedAt: Date }

/**
 * The month's signed copy that counts: the newest one uploaded after its latest reopening (any, if it was never
 * reopened). A copy from before the reopening is the one that was submitted, kept as history.
 */
export function currentSignedCopy<D extends SignedDoc>(
  docs: D[],
  period: string,
  lastReopenedAt: Date | null | undefined
): D | undefined {
  let found: D | undefined
  for (const d of docs)
    if (
      d.kind === 'signed-report' &&
      d.period === period &&
      (!lastReopenedAt || d.uploadedAt > lastReopenedAt) &&
      (!found || d.uploadedAt > found.uploadedAt)
    )
      found = d
  return found
}

/** A day as the screens say it: October 8, 2026. */
export const dayWords = (d: Date) =>
  d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** The export's name for an earlier signed copy: `Signed report as submitted 2026-10-08.pdf`. */
export const earlierSignedName = (submittedAt: Date, ext: string) =>
  `Signed report as submitted ${isoDay(submittedAt)}${ext}`

export interface Reopening {
  reopenedAt: Date
  reopenedByEmail: string
  reason: string
  submittedAt: Date
  approvedByName: string | null
  approvedAt: Date | null
  signedDocumentId: string | null
}

/** Reopenings.csv, oldest first: what each reopening undid, who reopened it and why, and where its signed copy is. */
export function reopeningRows(
  reopenings: Reopening[],
  signedPath: (r: Reopening) => string
): (string | number)[][] {
  return [
    [
      'Submitted on',
      'Month-end closing approved by',
      'Month-end closing approved on',
      'Reopened on',
      'Reopened by',
      'Why it was reopened',
      'Signed copy as submitted',
    ],
    ...[...reopenings]
      .sort((a, b) => a.reopenedAt.getTime() - b.reopenedAt.getTime())
      .map((r) => [
        isoDay(r.submittedAt),
        r.approvedByName ?? '',
        r.approvedAt ? isoDay(r.approvedAt) : '',
        isoDay(r.reopenedAt),
        r.reopenedByEmail,
        r.reason,
        signedPath(r),
      ]),
  ]
}

/** The README's line: "Reopened 2 times after it was submitted: see Reopenings.csv." */
export const reopenedWords = (n: number) =>
  `Reopened ${n === 1 ? 'once' : `${n} times`} after it was submitted to correct it: see Reopenings.csv; each earlier signed copy is in Earlier submissions/.`
