// Custom Casio F-91W seven-segment decoder — the primary recogniser (general
// OCR proved unreliable on this rigid font). Pure: operates on a binarised RGBA
// buffer (digit/bezel pixels black ≈ 0, LCD background white ≈ 255), so the
// browser app and the Node harness share identical logic.
//
// Pipeline: trim the black bezel → find the tall band of big HH:MM digits →
// split it into digit cells + colon by column gaps → read each digit by sampling
// its seven segment regions (on/off → digit). The smaller seconds sit as shorter
// cells to the right. Lots of tunable constants here — refine against the
// harness overlay (tools/out/*-decode.png).

export interface SegmentReading {
  hh: number
  mm: number
  ss: number
  confidence: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface CellDebug extends Box {
  digit: number | null
  conf: number
  kind: 'big' | 'small' | 'colon'
}

export interface DecodeDebug {
  trim: Box
  bigBand: Box | null
  cells: CellDebug[]
  note: string
}

export interface DecodeResult {
  reading: SegmentReading | null
  debug: DecodeDebug
}

const A = 1
const B = 2
const C = 4
const D = 8
const E = 16
const F = 32
const G = 64

const PATTERNS: Array<[number, number]> = [
  [0, A | B | C | D | E | F],
  [1, B | C],
  [2, A | B | G | E | D],
  [3, A | B | G | C | D],
  [4, F | G | B | C],
  [5, A | F | G | C | D],
  [6, A | F | G | E | C | D],
  [7, A | B | C],
  [8, A | B | C | D | E | F | G],
  [9, A | B | C | D | F | G],
]

const INK = 0.04 // min ink fraction to treat a row/column as "content"
const SEG_ON = 0.4 // min ink fraction for a segment to count as lit

export function decodeSegments(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): DecodeResult {
  const ink = new Uint8Array(width * height)
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) ink[p] = data[i] < 128 ? 1 : 0
  const at = (x: number, y: number): number => ink[y * width + x]

  // 1. Trim the near-solid black bezel frame.
  const rowFrac = (y: number, x0: number, x1: number): number => {
    let s = 0
    for (let x = x0; x < x1; x++) s += at(x, y)
    return s / (x1 - x0)
  }
  const colFrac = (x: number, y0: number, y1: number): number => {
    let s = 0
    for (let y = y0; y < y1; y++) s += at(x, y)
    return s / (y1 - y0)
  }
  let ty0 = 0
  let ty1 = height
  while (ty0 < ty1 && rowFrac(ty0, 0, width) > 0.7) ty0++
  while (ty1 > ty0 && rowFrac(ty1 - 1, 0, width) > 0.7) ty1--
  let tx0 = 0
  let tx1 = width
  while (tx0 < tx1 && colFrac(tx0, ty0, ty1) > 0.7) tx0++
  while (tx1 > tx0 && colFrac(tx1 - 1, ty0, ty1) > 0.7) tx1--

  const trim: Box = { x: tx0, y: ty0, w: tx1 - tx0, h: ty1 - ty0 }
  const debug: DecodeDebug = { trim, bigBand: null, cells: [], note: '' }
  if (trim.w < 10 || trim.h < 10) {
    debug.note = 'trim failed'
    return { reading: null, debug }
  }

  // 2. Tallest horizontal ink band = the big HH:MM digits.
  const rowMask: boolean[] = []
  for (let y = ty0; y < ty1; y++) rowMask.push(rowFrac(y, tx0, tx1) > INK)
  const bands = runs(rowMask)
  if (bands.length === 0) {
    debug.note = 'no ink bands'
    return { reading: null, debug }
  }
  const big = bands.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))
  const by0 = ty0 + big.start
  const by1 = ty0 + big.end
  debug.bigBand = { x: tx0, y: by0, w: trim.w, h: by1 - by0 }

  // 3. Split the band into column runs (digits + colon).
  const colMask: boolean[] = []
  for (let x = tx0; x < tx1; x++) colMask.push(colFrac(x, by0, by1) > INK)
  const groups = runs(colMask)
    .map((r) => tighten(at, tx0 + r.start, tx0 + r.end, by0, by1))
    .filter((g) => g.w > 1 && g.h > 1)
  if (groups.length === 0) {
    debug.note = 'no column groups'
    return { reading: null, debug }
  }

  // Classify by the tallest digit (the colon/seconds are shorter; the median
  // would be dragged down by them).
  const maxH = Math.max(...groups.map((g) => g.h))
  const digW = median(groups.filter((g) => g.h >= maxH * 0.65).map((g) => g.w)) || maxH * 0.5

  // 4. Classify + decode each group.
  let confSum = 0
  let confN = 0
  let colonX = -1
  const digits: Array<{ x: number; digit: number }> = []

  for (const g of groups) {
    const tall = g.h >= maxH * 0.65
    const narrow = g.w < digW * 0.55
    if (!tall && narrow) {
      if (colonX < 0) colonX = g.x
      debug.cells.push({ ...g, digit: null, conf: 1, kind: 'colon' })
      continue
    }
    // A "1" only inks its right side; widen the cell left to a full digit width.
    let cell: Box = g
    if (narrow && tall) cell = { x: Math.max(tx0, g.x - Math.round(digW - g.w)), y: g.y, w: Math.round(digW), h: g.h }
    const { digit, conf } = sampleDigit(at, cell)
    confSum += conf
    confN++
    const kind: 'big' | 'small' = tall ? 'big' : 'small'
    debug.cells.push({ ...cell, digit, conf, kind })
    if (digit != null) digits.push({ x: g.x, digit })
  }

  digits.sort((a, b) => a.x - b.x)
  if (colonX < 0) {
    debug.note = 'no colon found'
    return { reading: null, debug }
  }
  // Left of the colon = hours; after it, always MM then SS, left-to-right.
  const hours = digits.filter((d) => d.x < colonX).map((d) => d.digit)
  const afterColon = digits.filter((d) => d.x > colonX).map((d) => d.digit)
  const minutes = afterColon.slice(0, 2)
  const seconds = afterColon.slice(2, 4)

  if (hours.length < 1 || minutes.length < 2 || seconds.length < 2) {
    debug.note = `parts h${hours.length} after${afterColon.length}`
    return { reading: null, debug }
  }

  const toNum = (ds: number[]) => ds.slice(-2).reduce((a, d) => a * 10 + d, 0)
  const hh = toNum(hours)
  const mm = toNum(minutes)
  const ss = toNum(seconds)
  if (hh > 23 || mm > 59 || ss > 59) {
    debug.note = `range ${hh}:${mm}:${ss}`
    return { reading: null, debug }
  }

  debug.note = 'ok'
  return { reading: { hh, mm, ss, confidence: confN ? confSum / confN : 0 }, debug }
}

/** Shrink a column run to the tight ink bounding box. */
function tighten(
  at: (x: number, y: number) => number,
  gx0: number,
  gx1: number,
  by0: number,
  by1: number,
): Box {
  let x0 = gx1
  let x1 = gx0
  let y0 = by1
  let y1 = by0
  for (let y = by0; y < by1; y++) {
    for (let x = gx0; x < gx1; x++) {
      if (at(x, y)) {
        if (x < x0) x0 = x
        if (x + 1 > x1) x1 = x + 1
        if (y < y0) y0 = y
        if (y + 1 > y1) y1 = y + 1
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function sampleDigit(
  at: (x: number, y: number) => number,
  cell: Box,
): { digit: number | null; conf: number } {
  // Segment sample regions, normalised within the cell [x0,y0,x1,y1].
  const regions: Array<[number, number, number, number, number]> = [
    [A, 0.25, 0.0, 0.75, 0.2],
    [B, 0.74, 0.08, 1.0, 0.46],
    [C, 0.74, 0.54, 1.0, 0.92],
    [D, 0.25, 0.8, 0.75, 1.0],
    [E, 0.0, 0.54, 0.26, 0.92],
    [F, 0.0, 0.08, 0.26, 0.46],
    [G, 0.25, 0.4, 0.75, 0.6],
  ]
  let pattern = 0
  let margin = 1
  for (const [seg, rx0, ry0, rx1, ry1] of regions) {
    const x0 = cell.x + Math.floor(rx0 * cell.w)
    const x1 = cell.x + Math.ceil(rx1 * cell.w)
    const y0 = cell.y + Math.floor(ry0 * cell.h)
    const y1 = cell.y + Math.ceil(ry1 * cell.h)
    let s = 0
    let n = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        s += at(x, y)
        n++
      }
    }
    const frac = n ? s / n : 0
    if (frac > SEG_ON) pattern |= seg
    margin = Math.min(margin, Math.abs(frac - SEG_ON))
  }
  let best: number | null = null
  let bestDiff = 99
  for (const [digit, pat] of PATTERNS) {
    const diff = popcount(pat ^ pattern)
    if (diff < bestDiff) {
      bestDiff = diff
      best = digit
    }
  }
  const conf = (bestDiff === 0 ? 1 : bestDiff === 1 ? 0.5 : 0.1) * (0.5 + margin)
  return { digit: bestDiff <= 1 ? best : null, conf }
}

function runs(mask: boolean[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let s = -1
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && s < 0) s = i
    else if (!mask[i] && s >= 0) {
      out.push({ start: s, end: i })
      s = -1
    }
  }
  if (s >= 0) out.push({ start: s, end: mask.length })
  return out
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function popcount(n: number): number {
  let c = 0
  while (n) {
    c += n & 1
    n >>= 1
  }
  return c
}
