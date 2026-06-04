import type { PixelRect } from './geometry'

// Crops the time region out of the captured frame and binarises it for OCR:
// grayscale → Otsu threshold → black digits on white. Returns a canvas usable
// both as the OCR input and as the debug-view image. Adaptive thresholding can
// replace Otsu later if uneven lighting proves a problem (watch the debug view).

export interface Preprocessed {
  canvas: HTMLCanvasElement
  imageData: ImageData
  /** The Otsu threshold chosen, for debugging. */
  threshold: number
}

/** Upscale small crops so OCR has enough pixels to work with. */
const MIN_OCR_WIDTH = 600

export function preprocess(source: HTMLCanvasElement, crop: PixelRect): Preprocessed {
  const sx = Math.max(0, Math.min(crop.x, source.width - 1))
  const sy = Math.max(0, Math.min(crop.y, source.height - 1))
  const sw = Math.max(1, Math.min(crop.w, source.width - sx))
  const sh = Math.max(1, Math.min(crop.h, source.height - sy))

  const scale = sw < MIN_OCR_WIDTH ? MIN_OCR_WIDTH / sw : 1
  const dw = Math.round(sw * scale)
  const dh = Math.round(sh * scale)

  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh)

  const img = ctx.getImageData(0, 0, dw, dh)
  const data = img.data
  const n = dw * dh

  const gray = new Uint8ClampedArray(n)
  const hist = new Array<number>(256).fill(0)
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0
    gray[p] = g
    hist[g]++
  }

  const threshold = otsu(hist, n)

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const v = gray[p] <= threshold ? 0 : 255 // dark pixels (digits) → black on white
    data[i] = data[i + 1] = data[i + 2] = v
    data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)

  return { canvas, imageData: img, threshold }
}

/** Otsu's method: the global threshold maximising between-class variance. */
function otsu(hist: number[], total: number): number {
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) {
      maxVar = between
      threshold = t
    }
  }
  return threshold
}
