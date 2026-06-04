// Optional diagnostics, shown only with ?debug=1 in the URL. Surfaces the
// preprocessed (binarised) image plus the raw OCR text, confidence and
// threshold — the things we'll stare at while tuning recognition.

export function isDebug(): boolean {
  return new URLSearchParams(location.search).has('debug')
}

export interface DebugInfo {
  original?: HTMLCanvasElement
  preprocessed: HTMLCanvasElement
  raw: string
  confidence?: number
  threshold?: number
  crop?: { cx: number; cy: number; w: number; h: number }
}

export function renderDebug(container: HTMLElement, info: DebugInfo): void {
  container.innerHTML = ''

  const title = document.createElement('div')
  title.className = 'debug-title'
  title.textContent = 'debug — what the reader sees'
  container.appendChild(title)

  if (info.original) {
    container.appendChild(caption('raw crop'))
    info.original.className = 'debug-canvas'
    container.appendChild(info.original)
  }
  container.appendChild(caption('binarised (fed to OCR)'))
  info.preprocessed.className = 'debug-canvas'
  container.appendChild(info.preprocessed)

  const meta = document.createElement('pre')
  meta.className = 'debug-meta'
  const lines = [`raw OCR: ${JSON.stringify(info.raw)}`]
  if (info.confidence != null) lines.push(`confidence: ${(info.confidence * 100).toFixed(0)}%`)
  if (info.threshold != null) lines.push(`otsu threshold: ${info.threshold}`)
  if (info.crop) {
    lines.push(`crop w,h,cx,cy: ${info.crop.w},${info.crop.h},${info.crop.cx},${info.crop.cy}`)
  }
  meta.textContent = lines.join('\n')
  container.appendChild(meta)

  // Temporary sharing aid: copy an image as a data URL to paste into chat.
  const fallback = document.createElement('textarea')
  fallback.className = 'debug-fallback'
  fallback.readOnly = true
  fallback.hidden = true

  const copyBtn = (label: string, getData: () => string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = label
    b.addEventListener('click', async () => {
      const data = getData()
      try {
        await navigator.clipboard.writeText(data)
        b.textContent = `${label} ✓`
      } catch {
        fallback.value = data
        fallback.hidden = false
        fallback.focus()
        fallback.select()
      }
    })
    return b
  }

  const share = document.createElement('div')
  share.className = 'debug-share'
  if (info.original) {
    share.appendChild(copyBtn('copy raw crop', () => info.original!.toDataURL('image/jpeg', 0.6)))
  }
  share.appendChild(copyBtn('copy binarised', () => info.preprocessed.toDataURL('image/png')))
  container.append(share, fallback)
}

function caption(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'debug-title'
  el.textContent = text
  return el
}
