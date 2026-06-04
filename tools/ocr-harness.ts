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
import { binarize } from '../src/recognize/binarize.ts'
import { cropToPixels, type NormCrop } from '../src/recognize/geometry.ts'
import { decodeSegments } from '../src/recognize/segments.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const IMG_RE = /\.(png|jpe?g|webp)$/i
const MIN_WIDTH = 600

// Per-fixture time-band crops (normalised), estimated from the images and keyed
// by a filename substring. Tune against the overlays in tools/out/.
const CROPS: Record<string, NormCrop> = {
  'time-noretouch': { cx: 0.56, cy: 0.49, w: 0.58, h: 0.14 },
  'front-closeup': { cx: 0.49, cy: 0.56, w: 0.37, h: 0.15 },
  '5051': { cx: 0.5, cy: 0.49, w: 0.4, h: 0.12 },
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
    binarize(id.data, dw, dh)
    ctx.putImageData(id, 0, 0)

    const { reading, debug } = decodeSegments(id.data, dw, dh)

    // Annotated overlay.
    ctx.lineWidth = 2
    const rect = (b: { x: number; y: number; w: number; h: number }, color: string) => {
      ctx.strokeStyle = color
      ctx.strokeRect(b.x, b.y, b.w, b.h)
    }
    rect(debug.trim, 'red')
    if (debug.bigBand) rect(debug.bigBand, 'deepskyblue')
    ctx.font = '28px sans-serif'
    for (const c of debug.cells) {
      rect(c, c.kind === 'colon' ? 'orange' : c.digit != null ? 'lime' : 'magenta')
      if (c.digit != null) {
        ctx.fillStyle = 'red'
        ctx.fillText(String(c.digit), c.x + 2, Math.max(22, c.y - 3))
      }
    }
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
    console.log(`  overlay: tools/out/${basename(outPath)}`)
  }

  if (labelled > 0) console.log(`\n${correct}/${labelled} read correctly.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
