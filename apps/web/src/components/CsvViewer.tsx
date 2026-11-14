import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/hooks/useApi'
import { Button, ErrorNote } from '@/components/ui'
import './StatementViewer.css'
import './CsvViewer.css'

/** A CSV's rows: commas inside quotes and doubled quotes kept, blank lines left out. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const s = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x !== '')) rows.push(row)
  return rows
}

/**
 * A payroll CSV (timesheet, register, payroll details) shown as a grid in the app, every row as the file has it (a report's title lines
 * included), like a PDF in the statement viewer,
 * with Download under its own name (owner's decision, 2026-11-14). The bytes come through the API, which logs the open.
 */
export function CsvViewer({ src, downloadName }: { src: string; downloadName: string }) {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [rows, setRows] = useState<string[][] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The bytes as served, kept for Download: saving them fetches nothing again, so no second open is logged. */
  const kept = useRef<Blob | null>(null)

  useEffect(() => {
    let done = false
    setError(null)
    setRows(null)
    ;(async () => {
      try {
        const data = await apiRef.current.bytes(src)
        if (done) return
        kept.current = new Blob([data], { type: 'text/csv' })
        setRows(csvRows(new TextDecoder().decode(data)))
      } catch (e) {
        if (!done) setError(`The file could not be shown: ${(e as Error).message}`)
      }
    })()
    return () => {
      done = true
    }
  }, [src])

  const columns = Math.max(0, ...(rows ?? []).map((r) => r.length))
  return (
    <div className="ad-statement">
      <ErrorNote message={error} />
      {rows && (
        <div className="ad-statement-bar">
          <span className="text-xs text-soft">
            {rows.length} {rows.length === 1 ? 'row' : 'rows'}
          </span>
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
      <div className="ad-statement-pane ad-csv-pane">
        {!rows && !error && <p className="text-sm text-soft">Opening the file…</p>}
        {rows && (
          <table className="ad-csv">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {Array.from({ length: columns }, (_, j) => (
                    <td key={j}>{r[j] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
