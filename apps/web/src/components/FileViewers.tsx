import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/hooks/useApi'
import { Button, ErrorNote } from '@/components/ui'
import './StatementViewer.css'
import './CsvViewer.css'

/** Saves bytes already in hand under the file's own name: nothing is fetched again, so no second open is logged. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The file's bytes through the API (which logs the open), fetched once per `src`, with Download's copy kept. */
function useFileBytes(src: string, type: string) {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [blob, setBlob] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let done = false
    setError(null)
    setBlob(null)
    ;(async () => {
      try {
        const data = await apiRef.current.bytes(src)
        if (!done) setBlob(new Blob([data], { type }))
      } catch (e) {
        if (!done) setError(`The file could not be shown: ${(e as Error).message}`)
      }
    })()
    return () => {
      done = true
    }
  }, [src, type])
  return { blob, error }
}

function Bar({ blob, downloadName }: { blob: Blob; downloadName: string }) {
  return (
    <div className="ad-statement-bar">
      <span />
      <Button size="sm" kind="navy" onClick={() => saveBlob(blob, downloadName)}>
        Download
      </Button>
    </div>
  )
}

/** A picture (a receipt photo, a scanned record) shown in the app, with Download under its own name. */
export function ImageViewer({
  src,
  type,
  downloadName,
}: {
  src: string
  type: string
  downloadName: string
}) {
  const { blob, error } = useFileBytes(src, type)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) return
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return (
    <div className="ad-statement">
      <ErrorNote message={error} />
      {blob && <Bar blob={blob} downloadName={downloadName} />}
      <div className="ad-statement-pane">
        {!blob && !error && <p className="text-sm text-soft">Opening the file…</p>}
        {url && <img src={url} alt={downloadName} className="mx-auto block max-w-full" />}
      </div>
    </div>
  )
}

/**
 * A Word file shown in the app: its text, headings, tables and pictures turned into a page in the browser (nothing is
 * sent anywhere), drawn in a sandboxed frame that runs no script, with Download under its own name.
 */
export function DocxViewer({ src, downloadName }: { src: string; downloadName: string }) {
  const { blob, error } = useFileBytes(
    src,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
  const [html, setHtml] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) return
    let done = false
    setHtml(null)
    setReadError(null)
    ;(async () => {
      try {
        const mammoth = await import('mammoth')
        const out = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() })
        if (!done) setHtml(out.value)
      } catch (e) {
        if (!done) setReadError(`The file could not be shown: ${(e as Error).message}`)
      }
    })()
    return () => {
      done = true
    }
  }, [blob])
  const page =
    html !== null &&
    `<!doctype html><meta charset="utf-8"><style>body{font:14px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#fff;margin:24px;}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}img{max-width:100%}</style>${html || '<p>This file has no text to show.</p>'}`
  return (
    <div className="ad-statement">
      <ErrorNote message={error ?? readError} />
      {blob && <Bar blob={blob} downloadName={downloadName} />}
      <div className="ad-statement-pane ad-csv-pane">
        {!page && !error && !readError && <p className="text-sm text-soft">Opening the file…</p>}
        {page && (
          <iframe
            title={downloadName}
            sandbox=""
            srcDoc={page}
            className="block h-[70vh] w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  )
}
