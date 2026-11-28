import { useEffect, useState } from 'react'
import type { BudgetFileVersionDto, EngagementDetail } from '@ad/types'
import { canView, DocumentViewer } from '@/components/DocumentViewer'
import { useApi } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { Empty, ErrorNote, Modal } from '@/components/ui'

const CONTENT_TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
}
const typeOf = (f: BudgetFileVersionDto) =>
  CONTENT_TYPES[f.fileName.split('.').pop()?.toLowerCase() ?? ''] ?? ''

/**
 * The budget history (GitHub issue #98): every budget file saved for the engagement, as File Management shows the
 * month's files (the same tree), in two folders: the current budget's file and the earlier ones, newest first. Each
 * opens in the app's viewer or downloads as it was uploaded; there is no restore: upload an earlier file again. Owners
 * and bookkeepers only.
 */
export function BudgetHistoryModal({
  engagement: c,
  onClose,
}: {
  engagement: EngagementDetail
  onClose: () => void
}) {
  const api = useApi()
  const base = `/engagements/${c.id}/budget-lines/files`
  const [files, setFiles] = useState<BudgetFileVersionDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shut, setShut] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<BudgetFileVersionDto | null>(null)

  useEffect(() => {
    api.get<BudgetFileVersionDto[]>(base).then(setFiles, (e: Error) => setError(e.message))
  }, [api, base])

  const download = async (f: BudgetFileVersionDto) => {
    setError(null)
    try {
      await api.download(`${base}/${f.id}`, f.fileName)
    } catch (e) {
      setError(`${f.fileName} could not be downloaded: ${(e as Error).message}`)
    }
  }
  const folders = [
    { key: 'current', name: 'Current budget', files: (files ?? []).filter((f) => f.current) },
    { key: 'earlier', name: 'Earlier budgets', files: (files ?? []).filter((f) => !f.current) },
  ]
  const toggle = (key: string) =>
    setShut((was) => {
      const next = new Set(was)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  if (viewing)
    return (
      <Modal title={viewing.fileName} onClose={() => setViewing(null)} wide>
        <DocumentViewer
          file={{ fileName: viewing.fileName, contentType: typeOf(viewing) }}
          doc={{ id: viewing.id, sensitivity: 'financial' }}
          src={`${base}/${viewing.id}`}
        />
      </Modal>
    )

  return (
    <Modal title="Budget history" onClose={onClose} wide>
      <div className="grid gap-4">
        <p className="text-sm text-soft">
          Each budget file saved for {c.name}. To go back to an earlier budget, download its file
          and upload it again.
        </p>
        <ErrorNote message={error} />
        {files === null ? (
          !error && <Empty>Loading the budget files…</Empty>
        ) : files.length === 0 ? (
          <Empty>No budget file has been uploaded yet.</Empty>
        ) : (
          <ul className="wpc-files wpc-tree" aria-label="Budget files">
            {folders.map((g) => {
              const open = !shut.has(g.key)
              return (
                <li key={g.key} className="wpc-folder">
                  <div className="wpc-folder-row">
                    <button
                      type="button"
                      className="wpc-folder-name"
                      aria-expanded={open}
                      disabled={!g.files.length}
                      onClick={() => toggle(g.key)}
                    >
                      <span className="wpc-caret" aria-hidden>
                        {g.files.length ? (open ? '▾' : '▸') : ''}
                      </span>
                      <span className="wpc-folder-icon" aria-hidden />
                      {g.name}
                      <span className="wpc-count">
                        {g.files.length
                          ? `${g.files.length} ${g.files.length === 1 ? 'file' : 'files'}`
                          : 'empty'}
                      </span>
                    </button>
                  </div>
                  {open && g.files.length > 0 && (
                    <ul className="wpc-leaves">
                      {g.files.map((f) => (
                        <li key={f.id} className="wpc-leaf">
                          <span
                            className="wpc-leaf-name"
                            title={`${f.fileName}: ${f.lineCount} ${f.lineCount === 1 ? 'line' : 'lines'}, uploaded by ${f.uploadedByEmail}`}
                          >
                            {f.fileName}
                          </span>
                          <span className="wpc-leaf-date">{shortDate(f.uploadedAt)}</span>
                          {canView({ fileName: f.fileName, contentType: typeOf(f) }) && (
                            <button
                              type="button"
                              className="wpc-open"
                              aria-label={`View ${f.fileName}`}
                              onClick={() => setViewing(f)}
                            >
                              view
                            </button>
                          )}
                          <button
                            type="button"
                            className="wpc-open"
                            aria-label={`Download ${f.fileName}`}
                            onClick={() => void download(f)}
                          >
                            download
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
