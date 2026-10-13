import { useEffect, useRef, useState } from 'react'

/**
 * A looping step counter for the homepage graphics: 0, 1, 2 … steps, then a hold, then back to 0. It runs
 * only while the graphic is on screen, and stays on its last step for people who ask for reduced motion.
 */
export function useCycle(steps: number, stepMs: number, holdMs: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStep(steps)
      return
    }
    let timer: number | undefined
    let visible = false
    let current = 0
    const tick = () => {
      if (!visible) return
      current = current >= steps ? 0 : current + 1
      setStep(current)
      timer = window.setTimeout(tick, current >= steps ? holdMs : stepMs)
    }
    const seen = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      window.clearTimeout(timer)
      if (visible) timer = window.setTimeout(tick, stepMs)
    })
    if (ref.current) seen.observe(ref.current)
    return () => {
      seen.disconnect()
      window.clearTimeout(timer)
    }
  }, [steps, stepMs, holdMs])
  return { ref, step }
}

/** Draw a graphic at one width and scale it to fit its column, so every screen sees the same picture. */
export function useFit(designWidth: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = new ResizeObserver(([e]) =>
      setScale(Math.min(1, e.contentRect.width / designWidth))
    )
    fit.observe(el)
    return () => fit.disconnect()
  }, [designWidth])
  return { ref, scale }
}
