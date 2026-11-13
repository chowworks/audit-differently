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
 * A payroll file drawn in the browser with pdf.js, from its bytes as the API serves them (which logs the read), every
 * page one under another in a pane that scrolls, opened at the marked line's page with the line highlighted. A page is
 * drawn as it comes near view. With `onDraw`, the person drags a box on a page to mark the line by hand.
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
  /** The page it opens at, scrolled to the top of the pane; the mark's page when there is a mark. */
  page?: number
  mark?: StatementMark | null
  onDraw?: (mark: StatementMark) => void
  /** Offers Download: the bytes on screen (a payroll item's own highlighted copy), saved under this name. */
  downloadName?: string
}) {
  const api = useApi()
  const pane = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  /** The first page's size at the pane's width: every page's place before it is drawn. */
  const [first, setFirst] = useState<{ width: number; height: number } | null>(null)
  const [drawn, setDrawn] = useState<{ page: number; box: Box } | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The bytes as served, kept for Download: saving them fetches nothing again, so no second open is logged. */
  const kept = useRef<Blob | null>(null)
  // A pay stub is shown like the other payroll files (owner's decision, 2026-10-16); no other personal document is.
  const financial = doc.sensitivity === 'financial' || doc.kind === 'paystub'
  const open = mark?.page ?? startPage

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
        if (done) return
        const p = await opened.getPage(1)
        const one = p.getViewport({ scale: 1 })
        const width = pane.current?.clientWidth || 700
        if (done) return
        setFirst({ width, height: (one.height * width) / one.width })
        setPdf(opened)
      } catch (e) {
        if (!done) setError(`The statement could not be shown: ${(e as Error).message}`)
      }
    })()
    return () => {
      done = true
      // Off the page before it is destroyed, so nothing draws from a closed document.
      setPdf(null)
      setFirst(null)
      void loading?.destroy()
    }
  }, [doc.id, financial, src])

  // Opened at the page asked for (the mark's): scrolled to its top once the pages are placed.
  useEffect(() => {
    if (!pdf || !first || !pane.current) return
    const at = pane.current.querySelector<HTMLElement>(
      `[data-page="${Math.min(Math.max(open, 1), pdf.numPages)}"]`
    )
    if (at) pane.current.scrollTop = at.offsetTop
  }, [pdf, first, open])

  if (!financial)
    return <p className="text-sm text-soft">Personal documents are never previewed.</p>

  return (
    <div className="ad-statement">
      <ErrorNote message={error} />
      {pdf && (downloadName || pdf.numPages > 1) && (
        <div className="ad-statement-bar">
          <span className="text-xs text-soft">
            {pdf.numPages > 1 ? `${pdf.numPages} pages · scroll to see them all` : ''}
          </span>
          {downloadName && (
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
          )}
        </div>
      )}
      <div className="ad-statement-pane" ref={pane}>
        {!pdf && !error && <p className="text-sm text-soft">Opening the statement…</p>}
        {pdf &&
          first &&
          Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((n) => (
            <PageView
              key={n}
              pdf={pdf}
              n={n}
              of={pdf.numPages}
              width={first.width}
              guess={first.height}
              root={pane}
              mark={mark && mark.page === n ? mark : null}
              drawn={drawn?.page === n ? drawn.box : null}
              onDraw={
                onDraw
                  ? (box, v) => {
                      setDrawn({ page: n, box })
                      onDraw(toMark(v, n, box))
                    }
                  : undefined
              }
              onError={setError}
            />
          ))}
      </div>
    </div>
  )
}

/** One page: drawn when it comes near view, with its mark and the box drawn on it. */
function PageView({
  pdf,
  n,
  of,
  width,
  guess,
  root,
  mark,
  drawn,
  onDraw,
  onError,
}: {
  pdf: PDFDocumentProxy
  n: number
  of: number
  width: number
  /** Its height until drawn: the first page's. */
  guess: number
  root: React.RefObject<HTMLDivElement | null>
  mark: StatementMark | null
  drawn: Box | null
  onDraw?: (box: Box, v: PageViewport) => void
  onError: (message: string) => void
}) {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const [viewport, setViewport] = useState<PageViewport | null>(null)
  const [drawing, setDrawing] = useState<{ x: number; y: number; box: Box } | null>(null)

  useEffect(() => {
    const el = holder.current
    if (!el || near) return
    if (typeof IntersectionObserver === 'undefined') return setNear(true)
    const seen = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) setNear(true)
      },
      { root: root.current, rootMargin: '600px 0px' }
    )
    seen.observe(el)
    return () => seen.disconnect()
  }, [near, root])

  useEffect(() => {
    if (!near || !canvas.current) return
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    ;(async () => {
      try {
        const p = await pdf.getPage(n)
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
        if (!cancelled) onError(`The page could not be drawn: ${(e as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [near, pdf, n, width, onError])

  const point = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const shown = mark && viewport ? toBox(viewport, mark) : null

  return (
    <div className="ad-statement-pageblock" data-page={n} ref={holder}>
      {of > 1 && (
        <p className="ad-statement-pageno">
          Page {n} of {of}
        </p>
      )}
      <div className="ad-statement-page" style={viewport ? undefined : { height: guess, width }}>
        <canvas ref={canvas} />
        <div
          className={`ad-statement-overlay ${onDraw ? 'ad-statement-draw' : ''}`}
          onPointerDown={(e) => {
            if (!onDraw || !viewport) return
            const p = point(e)
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
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
            onDraw(b, viewport)
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
