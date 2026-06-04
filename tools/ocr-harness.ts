// Headless harness for the custom F-91W segment decoder: crops each image to the
// time band, binarises (shared logic), runs decodeSegments, scores against the
// filename label, and saves an annotated overlay to tools/out/*-decode.png so we
// can see exactly what the decoder detected and tune it.
//
//   npm run harness
//
// Images: tools/fixtures/ (licensed) + tools/local/ (gitignored scratch).
// Label times in the filename with hyphens: anything_10-42-15_24h.jpg.

import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { cropToPixels, type NormCrop } from '../src/recognize/geometry.ts'
import { decodeSegments } from '../src/recognize/segments.ts'
import { drawDecodeOverlay } from '../src/recognize/overlay.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const IMG_RE = /\.(png|jpe?g|webp)$/i
const MIN_WIDTH = 600

// Per-fixture time-band crops (normalised), estimated from the images and keyed
// by a filename substring. With LCD-anchoring the decoder tolerates surround in
// the crop, so these are deliberately generous — they only need to *contain* the
// time band; the decoder locks onto the LCD within. Tune against tools/out/.
const CROPS: Record<string, NormCrop> = {
  'time-noretouch': { cx: 0.56, cy: 0.5, w: 0.58, h: 0.18 },
  'front-closeup': { cx: 0.49, cy: 0.56, w: 0.37, h: 0.16 },
  '5051': { cx: 0.52, cy: 0.49, w: 0.58, h: 0.16 },
  'all-segments': { cx: 0.49, cy: 0.49, w: 0.44, h: 0.14 },
  // Broader set (tools/local): two clean fronts + two deliberately hard angles.
  'cand-1': { cx: 0.49, cy: 0.47, w: 0.44, h: 0.14 }, // angled — perspective, expected hard
  'cand-2': { cx: 0.49, cy: 0.52, w: 0.64, h: 0.2 },
  'cand-3': { cx: 0.49, cy: 0.52, w: 0.64, h: 0.2 },
  'cand-4': { cx: 0.5, cy: 0.82, w: 0.62, h: 0.1 },
}

function cropFor(file: string): NormCrop | null {
  const name = basename(file)
  for (const key of Object.keys(CROPS)) if (name.includes(key)) return CROPS[key]
  return null
}

interface Expected {
  hh: number
  mm: number
  ss: number
}
function expectedFromName(file: string): Expected | null {
  const m = basename(file).match(/(\d{1,2})-(\d{2})-(\d{2})/)
  return m ? { hh: +m[1], mm: +m[2], ss: +m[3] } : null
}

const fmt = (t: { hh: number; mm: number; ss: number }): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.hh)}:${p(t.mm)}:${p(t.ss)}`
}

async function main(): Promise<void> {
  const dirs = [join(HERE, 'fixtures'), join(HERE, 'local')].filter(existsSync)
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => IMG_RE.test(f))
      .map((f) => join(d, f)),
  )
  if (files.length === 0) {
    console.log('No images in tools/fixtures or tools/local.')
    return
  }
  mkdirSync(OUT, { recursive: true })

  let correct = 0
  let labelled = 0

  for (const file of files) {
    const expected = expectedFromName(file)
    const crop = cropFor(file)
    const img = await loadImage(file)

    let dw: number
    let dh: number
    let sx = 0
    let sy = 0
    let sw = img.width
    let sh = img.height
    if (crop) {
      const rect = cropToPixels(crop, img.width, img.height)
      sx = rect.x
      sy = rect.y
      sw = rect.w
      sh = rect.h
    }
    const scale = sw < MIN_WIDTH ? MIN_WIDTH / sw : 1
    dw = Math.round(sw * scale)
    dh = Math.round(sh * scale)

    const canvas = createCanvas(dw, dh)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh)
    const id = ctx.getImageData(0, 0, dw, dh)

    // decodeSegments owns binarisation now; feed it the raw cropped RGBA.
    const { reading, debug } = decodeSegments(id.data, dw, dh)

    // Paint the decoder's final ink mask as the overlay background, so the boxes
    // sit on exactly what the decoder saw.
    if (debug.ink) {
      for (let p = 0, i = 0; p < debug.ink.length; p++, i += 4) {
        const v = debug.ink[p] ? 0 : 255
        id.data[i] = id.data[i + 1] = id.data[i + 2] = v
        id.data[i + 3] = 255
      }
    }
    ctx.putImageData(id, 0, 0)

    // Annotated overlay (same renderer as the in-app ?debug=1 view).
    drawDecodeOverlay(ctx as unknown as CanvasRenderingContext2D, debug)
    const outPath = join(OUT, `${basename(file).replace(IMG_RE, '')}-decode.png`)
    writeFileSync(outPath, canvas.toBuffer('image/png'))

    let mark = ''
    if (expected) {
      labelled++
      const ok =
        !!reading && reading.hh === expected.hh && reading.mm === expected.mm && reading.ss === expected.ss
      if (ok) correct++
      mark = ok ? '  ✓' : '  ✗'
    }
    const cellStr = debug.cells.map((c) => (c.kind === 'colon' ? ':' : (c.digit ?? '?'))).join('')
    console.log(`\n=== ${basename(file)} ${expected ? `(expect ${fmt(expected)})${mark}` : ''}`)
    console.log(`  ${dw}×${dh}  note:${debug.note}  conf:${reading ? reading.confidence.toFixed(2) : '-'}`)
    console.log(`  decoded: ${reading ? fmt(reading) : 'none'}   cells:[${cellStr}]`)
    if (process.env.FRAC) {
      for (const c of debug.cells) {
        if (c.kind === 'colon' || !c.frac) continue
        const segs = c.frac.map((f, i) => `${'ABCDEFG'[i]}${f.toFixed(2)}`).join(' ')
        console.log(`    ${c.kind} -> ${c.digit ?? '?'}  ${segs}`)
      }
    }
    console.log(`  overlay: tools/out/${basename(outPath)}`)
  }

  if (labelled > 0) console.log(`\n${correct}/${labelled} read correctly.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
