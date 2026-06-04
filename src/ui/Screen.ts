import { Camera, type CameraError } from '../camera/Camera'
import { TimeSync } from '../time/TimeSync'
import { SegmentDecoderRecognizer } from '../recognize/SegmentDecoderRecognizer'
import { drawDecodeOverlay } from '../recognize/overlay'
import { preprocess } from '../recognize/preprocess'
import { TIME_CROP, cropToPixels, cropOverride, type NormCrop, type PixelRect } from '../recognize/geometry'
import { computeDrift, type DriftResult } from '../drift/Drift'
import { isDebug, renderDebug } from './DebugView'

type State = 'idle' | 'starting' | 'preview' | 'measuring' | 'result' | 'error'

// The whole single-screen app. Holds a stable DOM skeleton (so the live <video>
// survives state changes) and swaps text / buttons / visibility per state.
export class Screen {
  private readonly root: HTMLElement
  private readonly camera = new Camera()
  private readonly time = new TimeSync()
  // The F-91W segment decoder auto-detects the LCD in the whole frame, so we feed
  // it the full capture (no precise crop) and let it find the watch.
  private readonly recognizer = new SegmentDecoderRecognizer()
  private readonly debug = isDebug()

  private state: State = 'idle'
  private is24h = true
  private recognizerReady = false
  private retakeMsg = ''
  private lastDrift: DriftResult | null = null
  private crop: NormCrop = cropOverride() ?? TIME_CROP

  private video!: HTMLVideoElement
  private viewfinder!: HTMLElement
  private guide!: HTMLElement
  private answer!: HTMLElement
  private sub!: HTMLElement
  private cond!: HTMLElement
  private controls!: HTMLElement
  private debugBox!: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
    this.build()
    // Sync the clock in the background while the user gets the camera going.
    this.time
      .sync()
      .then(() => this.refreshCond())
      .catch(() => {})
  }

  private build(): void {
    this.root.innerHTML = `
      <h1 class="question">How many seconds is your watch off?</h1>
      <div class="viewfinder" hidden>
        <video playsinline muted></video>
        <div class="guide"></div>
      </div>
      <div class="answer" hidden></div>
      <p class="sub"></p>
      <p class="cond"></p>
      <div class="controls"></div>
      <div class="debug" hidden></div>
    `
    this.viewfinder = this.q('.viewfinder')
    this.video = this.q('video')
    this.guide = this.q('.guide')
    this.answer = this.q('.answer')
    this.sub = this.q('.sub')
    this.cond = this.q('.cond')
    this.controls = this.q('.controls')
    this.debugBox = this.q('.debug')
    this.applyGuide()
    this.setState('idle')
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T
  }

  /** Position the alignment box from the crop fractions. Because the viewfinder's
   *  aspect-ratio is set to the camera frame's, on-screen fractions map 1:1 to
   *  frame fractions — so what's framed is exactly what gets cropped for OCR. */
  private applyGuide(): void {
    const c = this.crop
    this.guide.style.left = `${(c.cx - c.w / 2) * 100}%`
    this.guide.style.top = `${(c.cy - c.h / 2) * 100}%`
    this.guide.style.width = `${c.w * 100}%`
    this.guide.style.height = `${c.h * 100}%`
  }

  private setState(state: State): void {
    this.state = state
    this.viewfinder.hidden = !(state === 'preview' || state === 'measuring')
    this.answer.hidden = state !== 'result'
    this.controls.innerHTML = ''

    switch (state) {
      case 'idle':
        this.setSub('Point your phone at your Casio F-91W and measure how far it has drifted from real time.')
        this.controls.append(this.btn('Start camera', () => void this.startCamera()))
        break
      case 'starting':
        this.setSub('Starting the camera…')
        break
      case 'preview':
        this.setSub(
          this.retakeMsg ||
            'Point the camera at your watch so the time shows clearly — no need to line it up. Hold about a hand away so it stays in focus, then Measure.',
        )
        this.retakeMsg = ''
        this.controls.append(this.btn('Measure', () => void this.measure()), this.modeToggle())
        if (this.debug) this.controls.append(this.sizeControls())
        break
      case 'measuring':
        // sub text is managed inside measure()
        break
      case 'result': {
        const d = this.lastDrift!
        this.answer.textContent = formatBig(d)
        this.setSub(formatSub(d))
        this.controls.append(this.btn('Measure again', () => this.setState('preview')))
        break
      }
      case 'error':
        break
    }
    this.refreshCond()
  }

  private async startCamera(): Promise<void> {
    this.setState('starting')
    const res = await this.camera.start(this.video)
    if (res.ok) {
      this.viewfinder.style.aspectRatio = `${res.value.width} / ${res.value.height}`
      this.applyGuide()
      this.retakeMsg = ''
      this.setState('preview')
    } else {
      this.showError(res.error)
    }
  }

  private async measure(): Promise<void> {
    if (this.state === 'measuring') return
    this.setState('measuring')
    try {
      if (!this.time.current) {
        this.setSub('Checking the time…')
        await this.time.sync()
        this.refreshCond()
      }

      // Capture (and timestamp) first — everything after this is post-capture.
      const cap = this.camera.capture()
      const trueUtc = this.time.trueUtcAt(cap.perfTimestamp)

      if (!this.recognizerReady) {
        this.setSub('Preparing the reader (first run only)…')
        await this.recognizer.init()
        this.recognizerReady = true
      }
      this.setSub('Reading the dial…')

      // Crop to the (large, forgiving) capture region, then decode — the decoder
      // auto-detects the LCD inside it; no precise alignment needed.
      const rect = cropToPixels(this.crop, cap.width, cap.height)
      const pre = preprocess(cap.canvas, rect)
      const rec = await this.recognizer.recognize({ canvas: pre.canvas, is24h: this.is24h })

      if (this.debug) {
        renderDebug(this.debugBox, {
          scene: cropCanvas(cap.canvas, rect, 480),
          decoded: this.decodedCanvas(),
          raw: rec.ok ? rec.value.raw : rec.raw ?? '',
          confidence: rec.ok ? rec.value.confidence : undefined,
          crop: this.crop,
        })
        this.debugBox.hidden = false
      }

      if (!rec.ok) {
        this.retakeMsg = retakeMessage(rec.reason)
        this.setState('preview')
        return
      }

      this.lastDrift = computeDrift(
        rec.value,
        trueUtc.epochMs,
        trueUtc.uncertaintyMs,
        new Date().getTimezoneOffset(),
        this.is24h,
      )
      this.setState('result')
    } catch {
      this.retakeMsg = 'Something went wrong reading that — try again.'
      this.setState('preview')
    }
  }

  /** ?debug=1 image: the decoder's detected LCD, binarised, with its band/cell
   *  boxes drawn on — so on a real watch you can see exactly what it locked onto. */
  private decodedCanvas(): HTMLCanvasElement | undefined {
    const dbg = this.recognizer.lastDebug
    if (!dbg?.crop) return undefined
    const { ink, width, height } = dbg.crop
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(width, height)
    for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
      const v = ink[p] ? 0 : 255
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    drawDecodeOverlay(ctx, dbg)
    return canvas
  }

  private showError(e: CameraError): void {
    this.state = 'error'
    this.viewfinder.hidden = true
    this.answer.hidden = true
    this.controls.innerHTML = ''
    this.setSub(cameraErrorMessage(e))
    if (e === 'denied' || e === 'no-camera') {
      this.controls.append(this.btn('Try again', () => void this.startCamera()))
    }
    this.refreshCond()
  }

  private btn(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  private modeToggle(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'mode'
    const label = document.createElement('span')
    label.className = 'mode-label'
    label.textContent = 'watch mode:'
    wrap.appendChild(label)

    const make = (text: string, is24h: boolean): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'textlink'
      b.textContent = text
      b.setAttribute('aria-pressed', String(this.is24h === is24h))
      b.addEventListener('click', () => {
        this.is24h = is24h
        wrap.querySelectorAll('button').forEach((btn) => {
          btn.setAttribute('aria-pressed', String((btn.textContent === '24h') === this.is24h))
        })
      })
      return b
    }
    wrap.append(make('12h', false), make('24h', true))
    return wrap
  }

  /** Debug-only live box sizing, so the crop can be dialled in on-device. */
  private sizeControls(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'mode'
    const readout = document.createElement('span')
    readout.className = 'mode-label'
    const update = (): void => {
      this.applyGuide()
      const c = this.crop
      readout.textContent = `box ${c.w.toFixed(2)}×${c.h.toFixed(2)} @ ${c.cx.toFixed(2)},${c.cy.toFixed(2)}`
    }
    const adj = (dw: number, dh: number) => (): void => {
      this.crop = {
        ...this.crop,
        w: clamp(this.crop.w + dw, 0.08, 1),
        h: clamp(this.crop.h + dh, 0.05, 1),
      }
      update()
    }
    const link = (label: string, on: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'textlink'
      b.textContent = label
      b.addEventListener('click', on)
      return b
    }
    wrap.append(
      link('W−', adj(-0.04, 0)),
      link('W+', adj(0.04, 0)),
      link('H−', adj(0, -0.03)),
      link('H+', adj(0, 0.03)),
      readout,
    )
    update()
    return wrap
  }

  private setSub(text: string): void {
    this.sub.textContent = text
  }

  private refreshCond(): void {
    this.cond.textContent = this.timeStatusText()
  }

  private timeStatusText(): string {
    const o = this.time.current
    if (!o) return 'checking the time…'
    if (o.degraded) {
      return '⚠ couldn’t reach a time server — using this device’s clock, so treat the result as rough.'
    }
    const names: Record<string, string> = {
      timeapi: 'timeapi.io',
      cloudflare: 'Cloudflare',
      'date-header': 'the server clock',
      device: 'this device',
    }
    return `time checked against ${names[o.source] ?? o.source}`
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function formatBig(d: DriftResult): string {
  const n = Math.round(d.offsetSec)
  if (n === 0) return '0 s'
  return `${n > 0 ? '+' : '−'}${Math.abs(n)} s`
}

function formatSub(d: DriftResult): string {
  const n = Math.round(d.offsetSec)
  if (n === 0) return 'Spot on — no drift to the nearest second.'
  const unit = Math.abs(n) === 1 ? 'second' : 'seconds'
  const word = d.direction === 'fast' ? 'fast' : 'slow'
  return `Your watch is ${Math.abs(n)} ${unit} ${word}.`
}

function retakeMessage(reason: 'low-confidence' | 'no-digits' | 'engine-error'): string {
  switch (reason) {
    case 'low-confidence':
      return 'Couldn’t read that confidently — line the digits up in the guide, avoid glare, and try again.'
    case 'no-digits':
      return 'Couldn’t find the time in that shot — fill the guide with the HH:MM:SS digits and try again.'
    case 'engine-error':
      return 'The reader hit a snag — try again.'
  }
}

function cameraErrorMessage(e: CameraError): string {
  switch (e) {
    case 'denied':
      return 'Camera permission was denied. This tool reads the watch on your device — nothing is uploaded. Allow the camera and try again.'
    case 'no-camera':
      return 'No usable camera was found on this device.'
    case 'insecure-context':
      return 'The camera needs a secure (https) connection.'
    case 'unavailable':
      return 'This browser doesn’t support camera access.'
  }
}

/** Build a downscaled colour crop of the captured frame, for the debug view. */
function cropCanvas(source: HTMLCanvasElement, rect: PixelRect, maxW: number): HTMLCanvasElement {
  const sx = Math.max(0, Math.min(rect.x, source.width - 1))
  const sy = Math.max(0, Math.min(rect.y, source.height - 1))
  const sw = Math.max(1, Math.min(rect.w, source.width - sx))
  const sh = Math.max(1, Math.min(rect.h, source.height - sy))
  const scale = sw > maxW ? maxW / sw : 1
  const c = document.createElement('canvas')
  c.width = Math.round(sw * scale)
  c.height = Math.round(sh * scale)
  c.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height)
  return c
}
