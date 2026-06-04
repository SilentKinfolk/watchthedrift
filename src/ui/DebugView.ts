// Optional diagnostics, shown only with ?debug=1 in the URL. Surfaces the
// preprocessed (binarised) image plus the raw OCR text, confidence and
// threshold — the things we'll stare at while tuning recognition.

export function isDebug(): boolean {
  return new URLSearchParams(location.search).has('debug')
}

export interface DebugInfo {
  preprocessed: HTMLCanvasElement
  raw: string
  confidence?: number
  threshold?: number
}

export function renderDebug(container: HTMLElement, info: DebugInfo): void {
  container.innerHTML = ''

  const title = document.createElement('div')
  title.className = 'debug-title'
  title.textContent = 'debug — preprocessed crop fed to OCR'
  container.appendChild(title)

  info.preprocessed.className = 'debug-canvas'
  container.appendChild(info.preprocessed)

  const meta = document.createElement('pre')
  meta.className = 'debug-meta'
  const lines = [`raw OCR: ${JSON.stringify(info.raw)}`]
  if (info.confidence != null) lines.push(`confidence: ${(info.confidence * 100).toFixed(0)}%`)
  if (info.threshold != null) lines.push(`otsu threshold: ${info.threshold}`)
  meta.textContent = lines.join('\n')
  container.appendChild(meta)
}
