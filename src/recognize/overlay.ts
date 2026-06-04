// Shared annotated-overlay renderer for the segment decoder's debug output, so
// the Node harness (tools/out/*-decode.png) and the in-app ?debug=1 view draw
// the SAME boxes: LCD panel (yellow), working region (red), big-digit band
// (sky blue), and each cell (orange colon / lime digit / magenta unread) with
// the digit it read. Typed against the browser CanvasRenderingContext2D; the
// harness passes @napi-rs/canvas's structurally-compatible context.

import type { Box, DecodeDebug } from './segments'

export function drawDecodeOverlay(ctx: CanvasRenderingContext2D, debug: DecodeDebug): void {
  const h = ctx.canvas.height
  ctx.lineWidth = clamp(Math.round(h / 300), 1, 6)
  const font = clamp(Math.round(h / 12), 12, 40)
  ctx.font = `${font}px sans-serif`

  const rect = (b: Box, color: string): void => {
    ctx.strokeStyle = color
    ctx.strokeRect(b.x, b.y, b.w, b.h)
  }
  if (debug.lcd) rect(debug.lcd, 'yellow')
  rect(debug.trim, 'red')
  if (debug.bigBand) rect(debug.bigBand, 'deepskyblue')
  for (const c of debug.cells) {
    rect(c, c.kind === 'colon' ? 'orange' : c.digit != null ? 'lime' : 'magenta')
    if (c.digit != null) {
      ctx.fillStyle = 'red'
      ctx.fillText(String(c.digit), c.x + 2, Math.max(font, c.y - 3))
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
