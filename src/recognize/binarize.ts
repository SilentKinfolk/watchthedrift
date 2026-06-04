// Pure grayscale + Otsu binarisation, shared by the browser preprocess
// (src/recognize/preprocess.ts) and the Node OCR harness (tools/ocr-harness.ts)
// so both run identical pixel logic. Mutates the RGBA buffer in place to
// black-on-white.

export function binarize(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): { threshold: number } {
  const n = width * height
  const gray = new Uint8ClampedArray(n)
  const hist = new Array<number>(256).fill(0)
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const g = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0
    gray[p] = g
    hist[g]++
  }
  const threshold = otsuThreshold(hist, n)
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const v = gray[p] <= threshold ? 0 : 255 // dark pixels (digits) → black on white
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v
    rgba[i + 3] = 255
  }
  return { threshold }
}

/** Otsu's method: the global threshold maximising between-class variance. */
export function otsuThreshold(hist: number[], total: number): number {
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
