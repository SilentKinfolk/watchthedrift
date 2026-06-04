// Headless harness for the custom F-91W segment decoder: feeds each WHOLE image
// (downscaled to a working size) to decodeSegments — which auto-detects the LCD —
// scores against the filename label, and saves an annotated overlay to
// tools/out/*-decode.png so we can see what it detected and tune it.
//
//   npm run harness
//   FRAC=1 npm run harness   # also print per-segment ink fractions
//
// Images: tools/fixtures/ (licensed) + tools/local/ (gitignored scratch).
// Label times in the filename with hyphens: anything_10-42-15_24h.jpg.

import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { decodeSegments } from '../src/recognize/segments.ts'
import { drawDecodeOverlay } from '../src/recognize/overlay.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const IMG_RE = /\.(png|jpe?g|webp)$/i
// Downscale so the longest side is at most this — mirrors what the app feeds the
// decoder (a phone frame, not full-res) and keeps the flood fill fast.
const WORK_MAX = 1600

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
    const img = await loadImage(file)

    const longest = Math.max(img.width, img.height)
    const scale = longest > WORK_MAX ? WORK_MAX / longest : 1
    const dw = Math.round(img.width * scale)
    const dh = Math.round(img.height * scale)

    const canvas = createCanvas(dw, dh)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, dw, dh)
    const id = ctx.getImageData(0, 0, dw, dh)

    // Feed the whole (downscaled) frame; decodeSegments finds the LCD itself.
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
