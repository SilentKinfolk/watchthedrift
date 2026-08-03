// Time sources, queried in parallel by TimeSync. Each performs one network
// request and returns the server's true-UTC instant plus that source's intrinsic
// resolution floor. The request must happen inside the call so TimeSync can time
// the round-trip around it.
//
// Every source here is treated as untrusted. On 2026-08-03 timeapi.io answered
// HTTP 200 with well-formed JSON, ~170 ms RTT and a host clock 1100.7 s slow —
// a falsetick in NTP's sense. Nothing about a single response distinguishes that
// from a good one, so the defence lives in TimeSync: several sources are sampled
// and only an instant that two of them corroborate is believed.

export type SourceId = 'cloudflare' | 'pages-date' | 'binance' | 'timeapi' | 'device'

export interface TimeSample {
  /** Server's true UTC at the moment it answered, epoch ms. */
  serverMs: number
  /** Intrinsic resolution floor of this source, ms (added to the ± band). */
  floorMs: number
}

export interface Source {
  id: SourceId
  /** Human name for the status line. */
  label: string
  fetch: (signal: AbortSignal) => Promise<TimeSample>
}

/** Cloudflare's trace endpoint exposes `ts=` and sends `access-control-allow-origin: *`.
 *  Most edges report milliseconds (`ts=1785722925.815`), but some truncate to a whole
 *  second (`ts=…034.000`), which would read 500 ms early. A whole-second value is
 *  therefore midpointed and given the matching ±500 ms floor. */
export async function fetchCloudflare(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch('https://cloudflare.com/cdn-cgi/trace', { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`cloudflare ${res.status}`)
  const m = (await res.text()).match(/^ts=(\d+)(?:\.(\d+))?/m)
  if (!m) throw new Error('cloudflare: no ts field')
  const whole = Number(m[1]) * 1000
  const frac = m[2] ? Number(`0.${m[2]}`) * 1000 : 0
  if (!Number.isFinite(whole)) throw new Error('cloudflare: unparseable ts')
  return frac > 0
    ? { serverMs: whole + frac, floorMs: 10 }
    : { serverMs: whole + 500, floorMs: 500 }
}

/** Same-origin `Date` header. Same-origin means it is readable without CORS
 *  exposure (`Date` is not on the CORS-safelist, so this only works on our own
 *  origin), but it is whole-second resolution — so we midpoint the second and
 *  floor the band at 500 ms. Verified 2026-08-03 that GitHub Pages' CDN rewrites
 *  `Date` to the serving instant even on a cache HIT (`Date` advanced in step with
 *  real time while `Age` climbed to 153 s), so no `Age` correction is applied. */
export async function fetchPagesDate(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch(location.href, { method: 'HEAD', signal, cache: 'no-store' })
  const date = res.headers.get('Date')
  if (!date) throw new Error('pages-date: not exposed')
  const ms = Date.parse(date)
  if (!Number.isFinite(ms)) throw new Error('pages-date: unparseable')
  return { serverMs: ms + 500, floorMs: 500 }
}

interface BinanceResponse {
  serverTime: number
}

/** Millisecond-resolution and CORS-enabled. An exchange's matching engine is
 *  disciplined to UTC as a condition of operating, which makes this a useful
 *  independent check on the other two. Geo-blocked in some regions (HTTP 451),
 *  which costs us a voter there and nothing else. */
export async function fetchBinance(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch('https://api.binance.com/api/v3/time', { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`binance ${res.status}`)
  const j = (await res.json()) as BinanceResponse
  if (!Number.isFinite(j.serverTime)) throw new Error('binance: unparseable time')
  return { serverMs: j.serverTime, floorMs: 1 }
}

interface TimeapiResponse {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  seconds: number
  milliSeconds: number
}

/** Kept as a fourth voter rather than removed: it was the falseticker of
 *  2026-08-03, and under corroboration a wrong source is outvoted instead of
 *  believed. Should its clock be repaired it rejoins the quorum on its own. */
export async function fetchTimeapi(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch('https://timeapi.io/api/time/current/zone?timeZone=Etc/UTC', {
    signal,
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`timeapi ${res.status}`)
  const j = (await res.json()) as TimeapiResponse
  const serverMs = Date.UTC(j.year, j.month - 1, j.day, j.hour, j.minute, j.seconds, j.milliSeconds)
  if (!Number.isFinite(serverMs)) throw new Error('timeapi: unparseable time')
  return { serverMs, floorMs: 1 }
}

/** The pool. Order is presentational only — every source is sampled in parallel
 *  and none of them can carry an estimate alone. */
export const SOURCES: Source[] = [
  { id: 'cloudflare', label: 'Cloudflare', fetch: fetchCloudflare },
  { id: 'pages-date', label: 'the server clock', fetch: fetchPagesDate },
  { id: 'binance', label: 'Binance', fetch: fetchBinance },
  { id: 'timeapi', label: 'timeapi.io', fetch: fetchTimeapi },
]

export const SOURCE_LABELS: Record<SourceId, string> = {
  cloudflare: 'Cloudflare',
  'pages-date': 'the server clock',
  binance: 'Binance',
  timeapi: 'timeapi.io',
  device: 'this device',
}
