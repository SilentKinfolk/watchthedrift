import type { PixelRect } from './geometry'
import { binarize } from './binarize'

// Crops the time region out of the captured frame and binarises it for OCR
// (grayscale → Otsu threshold → black digits on white). Returns a canvas usable
// both as the OCR input and as the debug-view image. The pixel work lives in
// ./binarize so the Node OCR harness shares exactly the same logic.

export interface Preprocessed {
  canvas: HTMLCanvasElement
  imageData: ImageData
  /** The Otsu threshold chosen, for debugging. */
  threshold: number
}

/** Upscale tiny crops so there are enough pixels to work with. */
const MIN_OCR_WIDTH = 600
/** Downscale big captures (we feed the decoder a large region) so the longest
 *  side is at most this — keeps the flood fill fast and matches the harness. */
const MAX_DECODE_LONGEST = 1600

export function preprocess(source: HTMLCanvasElement, crop: PixelRect): Preprocessed {
  const sx = Math.max(0, Math.min(crop.x, source.width - 1))
  const sy = Math.max(0, Math.min(crop.y, source.height - 1))
  const sw = Math.max(1, Math.min(crop.w, source.width - sx))
  const sh = Math.max(1, Math.min(crop.h, source.height - sy))

  const longest = Math.max(sw, sh)
  let scale = 1
  if (sw < MIN_OCR_WIDTH) scale = MIN_OCR_WIDTH / sw
  else if (longest > MAX_DECODE_LONGEST) scale = MAX_DECODE_LONGEST / longest
  const dw = Math.round(sw * scale)
  const dh = Math.round(sh * scale)

  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh)

  const img = ctx.getImageData(0, 0, dw, dh)
  const { threshold } = binarize(img.data, dw, dh)
  ctx.putImageData(img, 0, 0)

  return { canvas, imageData: img, threshold }
}
