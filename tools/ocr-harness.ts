// Headless OCR harness: runs the recognition pipeline over a folder of F-91W
// images so we can iterate on accuracy without a phone, and build up labelled
// test data. Reuses the app's own crop + binarise + parse logic, crops to the
// time band (full-image OCR is hopeless), and saves each binarised crop to
// tools/out/ so we can eyeball what the reader actually sees.
//
//   npm run harness
//
// Images: tools/fixtures/ (licensed) and tools/local/ (gitignored scratch).
// Encode the expected time in the filename to score it, with hyphens:
//   anything_10-42-15_24h.jpg  →  expect 10:42:15, 24-hour ("12h" ⇒ 12-hour).

import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorker, PSM } from 'tesseract.js'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { parseTime } from '../src/recognize/parse.ts'
import { binarize } from '../src/recognize/binarize.ts'
import { cropToPixels, type NormCrop } from '../src/recognize/geometry.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const IMG_RE = /\.(png|jpe?g|webp)$/i
const MIN_OCR_WIDTH = 600

// Per-fixture time-band crops (normalised), estimated from the images and keyed
// by a filename substring. Tune these against the saved crops in tools/out/.
const CROPS: Record<string, NormCrop> = {
  'time-noretouch': { cx: 0.55, cy: 0.52, w: 0.64, h: 0.17 },
  'front-closeup': { cx: 0.48, cy: 0.56, w: 0.42, h: 0.16 },
  '5051': { cx: 0.5, cy: 0.49, w: 0.42, h: 0.11 },
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
  is24h: boolean
}

function expectedFromName(file: string): Expected | null {
  const name = basename(file)
  const m = name.match(/(\d{1,2})-(\d{2})-(\d{2})/)
  if (!m) return null
  return { hh: +m[1], mm: +m[2], ss: +m[3], is24h: !/12h/i.test(name) }
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

  const langPath = join(HERE, '..', 'public', 'traineddata')
  const worker = await createWorker('digits', 1, { langPath, gzip: false })
  await worker.setParameters({
    tessedit_char_whitelist: '0123456789:',
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
  })

  let correct = 0
  let labelled = 0

  for (const file of files) {
    const expected = expectedFromName(file)
    const is24h = expected?.is24h ?? true
    const crop = cropFor(file)

    const img = await loadImage(file)

    let dw: number
    let dh: number
    const canvas = (() => {
      if (crop) {
        const rect = cropToPixels(crop, img.width, img.height)
        const scale = rect.w < MIN_OCR_WIDTH ? MIN_OCR_WIDTH / rect.w : 1
        dw = Math.round(rect.w * scale)
        dh = Math.round(rect.h * scale)
        const c = createCanvas(dw, dh)
        const ctx = c.getContext('2d')
        ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, dw, dh)
        const id = ctx.getImageData(0, 0, dw, dh)
        binarize(id.data, dw, dh)
        ctx.putImageData(id, 0, 0)
        return c
      }
      dw = img.width
      dh = img.height
      const c = createCanvas(dw, dh)
      c.getContext('2d').drawImage(img, 0, 0)
      return c
    })()

    const outPath = join(OUT, `${basename(file).replace(IMG_RE, '')}-crop.png`)
    writeFileSync(outPath, canvas.toBuffer('image/png'))

    const text = ((await worker.recognize(canvas.toBuffer('image/png'))).data.text ?? '').trim()
    const parsed = parseTime(text, is24h)

    let mark = ''
    if (expected) {
      labelled++
      const ok =
        !!parsed && parsed.hh === expected.hh && parsed.mm === expected.mm && parsed.ss === expected.ss
      if (ok) correct++
      mark = ok ? '  ✓' : '  ✗'
    }

    console.log(`\n=== ${basename(file)} ${expected ? `(expect ${fmt(expected)} ${expected.is24h ? '24h' : '12h'})${mark}` : ''}`)
    console.log(`  image ${img.width}×${img.height}, crop ${crop ? JSON.stringify(crop) : 'none'} → ${dw}×${dh}`)
    console.log(`  OCR: ${JSON.stringify(text)}  →  ${parsed ? fmt(parsed) : 'no parse'}`)
    console.log(`  saved: tools/out/${basename(outPath)}`)
  }

  await worker.terminate()
  if (labelled > 0) console.log(`\n${correct}/${labelled} labelled images read correctly.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
