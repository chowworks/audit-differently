import type { DocumentDto, DocumentKind, DocumentSensitivity } from '@ad/types'

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
