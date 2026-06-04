// Where the time digits sit, and how the on-screen alignment guide is shaped.
//
// The guide box and this crop are the SAME rectangle: the viewfinder's
// aspect-ratio is set to the live camera frame's, so the on-screen box maps 1:1
// to the cropped pixels. We crop just the HH:MM:SS band (wide and short) — the
// rest of the watch can sit outside it. The defaults are a starting point to be
// tuned against real F-91W photos; in debug you can override them live with
// ?crop=w,h,cx,cy (fractions 0..1) without rebuilding.

export interface NormCrop {
  cx: number
  cy: number
  w: number
  h: number
}

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

/** Centred band of the frame holding HH:MM:SS (normalised 0..1). Wide & short. */
export const TIME_CROP: NormCrop = { cx: 0.5, cy: 0.52, w: 0.4, h: 0.16 }

export function cropToPixels(c: NormCrop, frameW: number, frameH: number): PixelRect {
  const w = Math.round(c.w * frameW)
  const h = Math.round(c.h * frameH)
  return {
    x: Math.round(c.cx * frameW - w / 2),
    y: Math.round(c.cy * frameH - h / 2),
    w,
    h,
  }
}

/** Debug crop override from ?crop=w,h,cx,cy (fractions). null if absent/invalid. */
export function cropOverride(): NormCrop | null {
  const raw = new URLSearchParams(location.search).get('crop')
  if (!raw) return null
  const parts = raw.split(',').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [w, h, cx, cy] = parts
  return { w, h, cx, cy }
}
