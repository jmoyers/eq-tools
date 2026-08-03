// A tiny self-contained canvas confetti burst — no dependency, no network. Mounts
// a full-view overlay canvas, animates ~140 particles under gravity for ~3s, then
// calls onDone so the caller can unmount it. Colors are the app's tier palette so
// it reads on the dark theme. Keyed by the caller (e.g. burst id) to replay.

import { type JSX, useEffect, useRef } from 'react'

const COLORS = ['#5fbf72', '#6fb3d2', '#b07fd0', '#e0a94a', '#d9b25f', '#ffffff']
const DURATION_MS = 3000
const COUNT = 140

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  rot: number
  vrot: number
  color: string
}

export default function Confetti({ onDone }: { onDone?: () => void }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rect = canvas.parentElement?.getBoundingClientRect()
    const W = (canvas.width = rect?.width ?? window.innerWidth)
    const H = (canvas.height = rect?.height ?? window.innerHeight)

    // Two fountains from the lower-left and lower-right, arcing up and inward.
    const parts: Particle[] = Array.from({ length: COUNT }, (_, i) => {
      const left = i % 2 === 0
      return {
        x: left ? W * 0.15 : W * 0.85,
        y: H * 0.9,
        vx: (left ? 1 : -1) * (2 + Math.random() * 4),
        vy: -(8 + Math.random() * 7),
        size: 4 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.3,
        color: COLORS[(Math.random() * COLORS.length) | 0]
      }
    })

    const start = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      const t = now - start
      ctx.clearRect(0, 0, W, H)
      const fade = Math.max(0, 1 - t / DURATION_MS)
      for (const p of parts) {
        p.vy += 0.28 // gravity
        p.vx *= 0.99
        p.x += p.vx
        p.y += p.vy
        p.rot += p.vrot
        ctx.save()
        ctx.globalAlpha = fade
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = p.color
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6)
        ctx.restore()
      }
      if (t < DURATION_MS) raf = requestAnimationFrame(tick)
      else onDone?.()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 10
      }}
    />
  )
}
