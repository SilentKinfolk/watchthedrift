// Where the time digits sit, and how the on-screen alignment guide is shaped.
//
// First-pass values: the user fills the guide with the watch's time display, so
// we crop a centred band of the captured frame. These constants WILL be tuned
// against real F-91W photos using the debug view — that's expected iteration,
// and they're deliberately isolated here (the Phase-2 segment decoder reuses
// the same geometry).

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

/** Centred region of the frame expected to contain HH:MM:SS (normalised 0..1). */
export const TIME_CROP: NormCrop = { cx: 0.5, cy: 0.5, w: 0.86, h: 0.42 }

/** Aspect ratio (w / h) of the on-screen alignment guide — roughly the F-91W's
 *  time-digit band. */
export const GUIDE_ASPECT = 2.0

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
