import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/hooks/useApi'
import { Button, ErrorNote } from '@/components/ui'
import { readWorkbook, type WorkbookView } from '@/lib/xlsx'
import './StatementViewer.css'
import './CsvViewer.css'

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * A payroll spreadsheet (payroll details, the books' export behind an allocation worksheet) shown as a grid in the app,
 * like a CSV in the CSV viewer: a button per sheet, the rows its copy highlights filled yellow, opening at the sheet the
 * workbook opens at (a books line's note first), with Download under its own name. The bytes come through the API,
 * which logs the open; the file is read here, in the browser.
 */
export function SheetViewer({ src, downloadName }: { src: string; downloadName: string }) {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [book, setBook] = useState<WorkbookView | null>(null)
  const [shown, setShown] = useState(0)
  const [error, setError] = useState<string | null>(null)
  /** The bytes as served, kept for Download: saving them fetches nothing again, so no second open is logged. */
  const kept = useRef<Blob | null>(null)
  const pane = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let done = false
    setError(null)
    setBook(null)
    ;(async () => {
      try {
        const data = await apiRef.current.bytes(src)
        if (done) return
        kept.current = new Blob([data], { type: XLSX_TYPE })
        const read = readWorkbook(new Uint8Array(data))
        setBook(read)
        setShown(read.active)
      } catch (e) {
        if (!done) setError(`The file could not be shown: ${(e as Error).message}`)
      }
    })()
    return () => {
      done = true
    }
  }, [src])

  // The first highlighted row in view when a sheet opens.
  useEffect(() => {
    const el = pane.current
    if (!el || !book) return
    el.scrollTop = 0
    const first = el.querySelector<HTMLElement>('.ad-sheet-filled')
    if (first) el.scrollTop = Math.max(0, first.offsetTop - 40)
  }, [book, shown])

  const sheet = book?.sheets[shown]
  return (
    <div className="ad-statement">
      <ErrorNote message={error} />
      {book && (
        <div className="ad-statement-bar">
          <div className="flex flex-wrap items-center gap-1">
            {book.sheets.length > 1 &&
              book.sheets.map((s, i) => (
                <Button
                  key={i}
                  size="sm"
                  kind={i === shown ? 'navy' : 'secondary'}
                  aria-pressed={i === shown}
                  onClick={() => setShown(i)}
                >
                  {s.name}
                </Button>
              ))}
            {sheet && (
              <span className="ml-1 text-xs text-soft">
                {sheet.rows.length} {sheet.rows.length === 1 ? 'row' : 'rows'}
              </span>
            )}
          </div>
          <Button
            size="sm"
            kind="navy"
            onClick={() => {
              if (!kept.current) return
              const url = URL.createObjectURL(kept.current)
              const a = document.createElement('a')
              a.href = url
              a.download = downloadName
              document.body.appendChild(a)
              a.click()
              a.remove()
              setTimeout(() => URL.revokeObjectURL(url), 10_000)
            }}
          >
            Download
          </Button>
        </div>
      )}
      <div ref={pane} className="ad-statement-pane ad-csv-pane">
        {!book && !error && <p className="text-sm text-soft">Opening the file…</p>}
        {book && !sheet && (
          <p className="text-sm text-soft">This workbook has no sheets to show.</p>
        )}
        {sheet && (
          <table className="ad-csv">
            <tbody>
              {sheet.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => {
                    const at = `${i}:${j}`
                    const cls = [
                      sheet.filled.has(at) ? 'ad-sheet-filled' : '',
                      sheet.bold.has(at) ? 'font-semibold' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                    return (
                      <td key={j} className={cls || undefined}>
                        {cell}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
