import type {
  DocumentDto,
  DocumentKind,
  DocumentSensitivity,
  EngagementDetail,
  ReportDetail,
} from '@ad/types'

/**
 * What POST /documents answers: the new document; the month's page when it went into a month's proof; the
 * engagement's page when it went into a participant's file (the file, the counts and the months' checks change).
 */
export type UploadResult = DocumentDto & { report?: ReportDetail; engagement?: EngagementDetail }

export function documentDto(d: {
  id: string
  kind: string
  sensitivity: string
  fileName: string
  contentType: string
  size: number
  period: string | null
  uploadedAt: Date
}): DocumentDto {
  return {
    id: d.id,
    kind: d.kind as DocumentKind,
    sensitivity: d.sensitivity as DocumentSensitivity,
    fileName: d.fileName,
    contentType: d.contentType,
    size: d.size,
    period: d.period,
    uploadedAt: d.uploadedAt.toISOString(),
  }
}
