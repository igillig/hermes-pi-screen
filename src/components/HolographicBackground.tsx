import { useEffect, useRef } from 'react'

function drawHexGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const size = 28
  const hexH = size * Math.sqrt(3)
  ctx.strokeStyle = 'rgba(0, 212, 255, 0.07)'
  ctx.lineWidth = 0.8

  for (let col = -1; col < w / (size * 1.5) + 2; col++) {
    for (let row = -1; row < h / hexH + 2; row++) {
      const x = col * size * 3
      const y = row * hexH + (col % 2 !== 0 ? hexH / 2 : 0)
      ctx.beginPath()
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6
        const px = x + size * Math.cos(angle)
        const py = y + size * Math.sin(angle)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.stroke()
    }
  }
}

export default function HolographicBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = canvas.offsetWidth
    canvas.height = canvas.offsetHeight
    drawHexGrid(ctx, canvas.width, canvas.height)
  }, [])

  return (
    <div className="holo-bg" aria-hidden="true">
      <canvas ref={canvasRef} className="hex-canvas" />
      <div className="scan-line" />
      <div className="corner corner-tl" />
      <div className="corner corner-tr" />
      <div className="corner corner-bl" />
      <div className="corner corner-br" />
    </div>
  )
}
