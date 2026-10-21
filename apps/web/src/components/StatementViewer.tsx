import { useEffect, useRef, useState } from 'react'
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PageViewport,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { DocumentDto, StatementMark } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { Button, ErrorNote } from '@/components/ui'
import './StatementViewer.css'

GlobalWorkerOptions.workerSrc = workerUrl

type Box = { left: number; top: number; width: number; height: number }

/** A mark in PDF points as a box on the rendered page, in CSS pixels. */
function toBox(v: PageViewport, m: StatementMark): Box {
  const [x1, y1] = v.convertToViewportPoint(m.x, m.y) as [number, number]
  const [x2, y2] = v.convertToViewportPoint(m.x + m.width, m.y + m.height) as [number, number]
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

/** A box drawn on the rendered page, in CSS pixels, as a mark in PDF points. */
function toMark(v: PageViewport, page: number, b: Box): StatementMark {
  const [x1, y1] = v.convertToPdfPoint(b.left, b.top) as [number, number]
  const [x2, y2] = v.convertToPdfPoint(b.left + b.width, b.top + b.height) as [number, number]
  const r = (n: number) => Math.round(n * 100) / 100
  return {
    page,
    x: r(Math.min(x1, x2)),
    y: r(Math.min(y1, y2)),
    width: r(Math.abs(x2 - x1)),
    height: r(Math.abs(y2 - y1)),
  }
}

/**
 * A payroll file's page drawn in the browser with pdf.js, from its bytes as the API serves them (which logs the read),
 * with the marked line highlighted. With `onDraw`, the person drags a box on the page to mark the line by hand.
 * Financial documents and pay stubs only: any other personal document is never previewed, so this shows nothing for one.
 */
export function StatementViewer({
  doc,
  src,
  page: startPage = 1,
  mark,
  onDraw,
  downloadName,
}: {
  doc: Pick<DocumentDto, 'id' | 'sensitivity'> & { kind?: string }
  /** Where the bytes come from, when not a filed bank statement: a payroll match's staged file. */
  src?: string
  page?: number
  mark?: StatementMark | null
  onDraw?: (mark: StatementMark) => void
  /** Offers Download: the bytes on screen (a payroll item's own highlighted copy), saved under this name. */
  downloadName?: string
}) {
  const api = useApi()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(startPage)
  const [viewport, setViewport] = useState<PageViewport | null>(null)
  const [drawing, setDrawing] = useState<{ x: number; y: number; box: Box } | null>(null)
  const [drawn, setDrawn] = useState<Box | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The bytes as served, kept for Download: saving them fetches nothing again, so no second open is logged. */
  const kept = useRef<Blob | null>(null)
  // A pay stub is shown like the other payroll files (owner's decision, 2026-10-16); no other personal document is.
  const financial = doc.sensitivity === 'financial' || doc.kind === 'paystub'

  useEffect(() => setPage(mark?.page ?? startPage), [mark?.page, startPage])
  useEffect(() => setDrawn(null), [page])

  // The API client through a ref: its identity changes with Clerk's user object, and fetching again would log
  // another open of the statement.
  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => {
    if (!financial) return
    setError(null)
    let done = false
    let loading: ReturnType<typeof getDocument> | null = null
    ;(async () => {
      try {
        // Through the API with the session's token (which logs the open), never from storage directly.
        const data = await apiRef.current.bytes(src ?? `/payroll/statements/${doc.id}/file`)
        if (done) return
        // pdf.js takes the array it is given to its worker, so Download keeps its own copy.
        kept.current = new Blob([data.slice(0)], { type: 'application/pdf' })
        loading = getDocument({ data: new Uint8Array(data) })
        const opened = await loading.promise
        if (!done) setPdf(opened)
      } catch (e) {
        if (!done) setError(`The statement could not be shown: ${(e as Error).message}`)
      }
    })()
    return () => {
      done = true
      // Off the page before it is destroyed, so nothing draws from a closed document.
      setPdf(null)
      setViewport(null)
      void loading?.destroy()
    }
  }, [doc.id, financial, src])

  useEffect(() => {
    if (!pdf || !canvas.current) return
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    ;(async () => {
      try {
        const p = await pdf.getPage(Math.min(Math.max(page, 1), pdf.numPages))
        const width = canvas.current?.parentElement?.clientWidth || 700
        const v = p.getViewport({ scale: width / p.getViewport({ scale: 1 }).width })
        const c = canvas.current
        if (cancelled || !c) return
        const ratio = window.devicePixelRatio || 1
        c.width = Math.floor(v.width * ratio)
        c.height = Math.floor(v.height * ratio)
        c.style.width = `${v.width}px`
        c.style.height = `${v.height}px`
        task = p.render({
          canvas: c,
          viewport: v,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        })
        await task.promise.catch(() => undefined)
        if (!cancelled) setViewport(v)
      } catch (e) {
        // The document was closed while the page was drawing (another statement was chosen), or the page failed.
        if (!cancelled) setError(`The page could not be drawn: ${(e as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, page])

  if (!financial)
    return <p className="text-sm text-soft">Personal documents are never previewed.</p>

  const point = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const shown = mark && mark.page === page && viewport ? toBox(viewport, mark) : null

  return (
    <div className="ad-statement">
      <ErrorNote message={error} />
      {pdf && downloadName && (
        <div className="ad-statement-download">
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
      {pdf && pdf.numPages > 1 && (
        <div className="ad-statement-pages">
          <Button size="sm" kind="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹ previous page
          </Button>
          <span className="text-xs text-soft">
            Page {page} of {pdf.numPages}
          </span>
          <Button
            size="sm"
            kind="ghost"
            disabled={page >= pdf.numPages}
            onClick={() => setPage(page + 1)}
          >
            next page ›
          </Button>
        </div>
      )}
      <div className="ad-statement-page">
        {!pdf && !error && <p className="text-sm text-soft">Opening the statement…</p>}
        <canvas ref={canvas} />
        <div
          className={`ad-statement-overlay ${onDraw ? 'ad-statement-draw' : ''}`}
          onPointerDown={(e) => {
            if (!onDraw || !viewport) return
            const p = point(e)
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            setDrawn(null)
            setDrawing({ ...p, box: { left: p.x, top: p.y, width: 0, height: 0 } })
          }}
          onPointerMove={(e) => {
            if (!drawing) return
            const p = point(e)
            setDrawing({
              ...drawing,
              box: {
                left: Math.min(p.x, drawing.x),
                top: Math.min(p.y, drawing.y),
                width: Math.abs(p.x - drawing.x),
                height: Math.abs(p.y - drawing.y),
              },
            })
          }}
          onPointerUp={() => {
            if (!drawing || !viewport || !onDraw) return
            const b = drawing.box
            setDrawing(null)
            if (b.width < 4 || b.height < 4) return
            setDrawn(b)
            onDraw(toMark(viewport, page, b))
          }}
        >
          {shown && <div className="ad-statement-mark" style={shown} />}
          {(drawing?.box ?? drawn) && (
            <div className="ad-statement-mark" style={drawing?.box ?? drawn ?? undefined} />
          )}
        </div>
      </div>
    </div>
  )
}
