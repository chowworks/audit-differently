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
 * A Word file shown in the app as the PDF viewer shows a PDF: its pages one under another in the same pane, each in the
 * same page frame with "Page N of M" above it, and Download under its own name. The file is laid out in the browser
 * (docx-preview; nothing is sent anywhere), its pages broken where Word last broke them. Each page is drawn in a
 * sandboxed frame that runs no script, scaled to the pane's width.
 */
export function DocxViewer({ src, downloadName }: { src: string; downloadName: string }) {
  const { blob, error } = useFileBytes(
    src,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
  const [pages, setPages] = useState<{ html: string; width: number }[] | null>(null)
  const [styles, setStyles] = useState('')
  const [readError, setReadError] = useState<string | null>(null)
  const pane = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!blob) return
    let done = false
    setPages(null)
    setReadError(null)
    ;(async () => {
      try {
        const { renderAsync } = await import('docx-preview')
        // Laid out off the page, then copied into each page's frame: nothing of the file joins the app's own page.
        const body = document.createElement('div')
        const head = document.createElement('div')
        await renderAsync(blob, body, head, {
          inWrapper: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          useBase64URL: true,
          renderComments: false,
          renderChanges: false,
        })
        if (done) return
        const sections = [...body.querySelectorAll<HTMLElement>('section.docx')]
        setStyles(head.innerHTML)
        setPages(
          sections.map((sec) => ({
            html: sec.outerHTML,
            // The page's width as Word sets it ("8.5in" → px at 96 per inch), to scale it to the pane.
            width: cssPixels(sec.style.width) || 816,
          }))
        )
      } catch (e) {
        if (!done) setReadError(`The file could not be shown: ${(e as Error).message}`)
      }
    })()
    return () => {
      done = true
    }
  }, [blob])

  useEffect(() => {
    const el = pane.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  const n = pages?.length ?? 0
  return (
    <div className="ad-statement">
      <ErrorNote message={error ?? readError} />
      {blob && pages && (
        <div className="ad-statement-bar">
          <span className="text-xs text-soft">
            {n > 1 ? `${n} pages · scroll to see them all` : ''}
          </span>
          <Button size="sm" kind="navy" onClick={() => saveBlob(blob, downloadName)}>
            Download
          </Button>
        </div>
      )}
      <div className="ad-statement-pane" ref={pane}>
        {!pages && !error && !readError && <p className="text-sm text-soft">Opening the file…</p>}
        {pages && n === 0 && <p className="text-sm text-soft">This file has no pages to show.</p>}
        {pages &&
          width > 0 &&
          pages.map((p, i) => (
            <div key={i} className="ad-statement-pageblock" data-page={i + 1}>
              {n > 1 && (
                <p className="ad-statement-pageno">
                  Page {i + 1} of {n}
                </p>
              )}
              <div className="ad-statement-page">
                <DocxPage html={p.html} styles={styles} scale={(width - 2) / p.width} />
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

/** "8.5in", "612pt" or "816px" in CSS pixels. */
export function cssPixels(v: string): number {
  const m = /^([\d.]+)(in|pt|px|cm|mm)$/.exec(v.trim())
  if (!m) return 0
  const n = Number(m[1])
  return { in: n * 96, pt: (n * 96) / 72, px: n, cm: (n * 96) / 2.54, mm: (n * 96) / 25.4 }[
    m[2] as 'in' | 'pt' | 'px' | 'cm' | 'mm'
  ]
}

/**
 * One page in a frame that runs no script (sandbox without allow-scripts; same origin only so its height can be read),
 * scaled to the pane's width.
 */
function DocxPage({ html, styles, scale }: { html: string; styles: string; scale: number }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(0)
  const doc = `<!doctype html><meta charset="utf-8">${styles}<style>html,body{margin:0;background:#fff;overflow:hidden}body{zoom:${scale}}section.docx{margin:0!important;box-shadow:none!important}</style>${html}`
  return (
    <iframe
      ref={frame}
      title="Page"
      sandbox="allow-same-origin"
      srcDoc={doc}
      scrolling="no"
      onLoad={() => {
        const d = frame.current?.contentDocument
        if (d) setHeight(Math.ceil(d.documentElement.scrollHeight))
      }}
      className="block w-full border-0"
      style={{ height: height || 400 }}
    />
  )
}
