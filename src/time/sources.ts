// Time sources, queried in parallel by TimeSync. Each performs one network
// request and returns the server's true-UTC instant plus that source's intrinsic
// resolution floor. The request must happen inside the call so TimeSync can time
// the round-trip around it.
//
// Every source here is treated as untrusted. On 2026-08-03 timeapi.io answered
// HTTP 200 with well-formed JSON, ~170 ms RTT and a host clock 1101 s slow, losing
// a further 43 s/day — a falsetick in NTP's sense. Nothing about a single response
// distinguishes that from a good one, so the defence lives in TimeSync: several
// sources are sampled and only an instant that two of them corroborate is believed.
//
// The pool is constrained by what a browser can reach. A cross-origin response
// header is unreadable unless the server sends CORS headers, and `Date` is not on
// the CORS-safelist, so it is readable either same-origin or where a server names
// it in `Access-Control-Expose-Headers`. Measured 2026-08-03: NIST's HTTP endpoints
// time out or 404 and send no CORS headers; worldtimeapi.org is dead; the npm
// registry, Postman Echo, api.weather.gov and www.gov.uk send no readable `Date`;
// carbonintensity.org.uk resolves only to the half hour.

export type SourceId = 'cloudflare' | 'pages-date' | 'google' | 'wikipedia' | 'device'

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

/** A whole-second server time, midpointed. A server reporting second D generated
 *  the response somewhere in [D, D+1), so D + 500 ms is the unbiased estimate and
 *  ±500 ms is the honest band. Same reasoning as the watch face in Drift.ts. */
function wholeSecond(ms: number): TimeSample {
  return { serverMs: ms + 500, floorMs: 500 }
}

/** Cloudflare's trace endpoint exposes `ts=` and sends `access-control-allow-origin: *`.
 *  The pool's only sub-second source, so it usually supplies the point estimate.
 *  Most edges report milliseconds (`ts=1785722925.815`), but some truncate to a whole
 *  second (`ts=…034.000`), which would read 500 ms early, so a whole-second value is
 *  midpointed like the others. */
export async function fetchCloudflare(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch('https://cloudflare.com/cdn-cgi/trace', { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`cloudflare ${res.status}`)
  const m = (await res.text()).match(/^ts=(\d+)(?:\.(\d+))?/m)
  if (!m) throw new Error('cloudflare: no ts field')
  const whole = Number(m[1]) * 1000
  if (!Number.isFinite(whole)) throw new Error('cloudflare: unparseable ts')
  const frac = m[2] ? Number(`0.${m[2]}`) * 1000 : 0
  return frac > 0 ? { serverMs: whole + frac, floorMs: 10 } : wholeSecond(whole)
}

/** Same-origin `Date` header, readable without CORS exposure. This source is the
 *  pool's floor: a visitor who can load the page can always read it. Verified
 *  2026-08-03 that GitHub Pages' CDN rewrites `Date` to the serving instant even on
 *  a cache HIT (`Date` advanced in step with real time while `Age` climbed to 153 s),
 *  so no `Age` correction is applied. */
export async function fetchPagesDate(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch(location.href, { method: 'HEAD', signal, cache: 'no-store' })
  return wholeSecond(parseDateHeader(res, 'pages-date'))
}

/** Google's API front end names `date` in `Access-Control-Expose-Headers`, which
 *  is what makes its clock readable from a browser at all; almost nothing else
 *  does. The discovery endpoint is unauthenticated and `fields=kind` trims the
 *  body to a couple of dozen bytes, since only the header is wanted. */
export async function fetchGoogle(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch('https://www.googleapis.com/discovery/v1/apis?fields=kind', {
    signal,
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`google ${res.status}`)
  return wholeSecond(parseDateHeader(res, 'google'))
}

interface ExpandTemplatesResponse {
  expandtemplates?: { wikitext?: string }
}

/** MediaWiki expands {{CURRENTTIMESTAMP}} to the serving host's UTC clock as
 *  YYYYMMDDHHMMSS. `origin=*` is what makes MediaWiki send the wildcard CORS
 *  header for an anonymous request. Wikimedia is the pool's one non-commercial
 *  operator, which is worth something when the whole point is independence. */
export async function fetchWikipedia(signal: AbortSignal): Promise<TimeSample> {
  const url =
    'https://en.wikipedia.org/w/api.php?action=expandtemplates' +
    '&text=%7B%7BCURRENTTIMESTAMP%7D%7D&prop=wikitext&format=json&origin=*'
  const res = await fetch(url, { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`wikipedia ${res.status}`)
  const j = (await res.json()) as ExpandTemplatesResponse
  const m = j.expandtemplates?.wikitext?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (!m) throw new Error('wikipedia: unparseable timestamp')
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  if (!Number.isFinite(ms)) throw new Error('wikipedia: unparseable timestamp')
  return wholeSecond(ms)
}

function parseDateHeader(res: Response, id: SourceId): number {
  const date = res.headers.get('Date')
  if (!date) throw new Error(`${id}: Date not exposed`)
  const ms = Date.parse(date)
  if (!Number.isFinite(ms)) throw new Error(`${id}: unparseable Date`)
  return ms
}

/** The pool. Order is presentational only, since every source is sampled in
 *  parallel and none of them can carry an estimate alone. Four unrelated
 *  operators — a CDN, the host serving this page, Google and the Wikimedia
 *  Foundation — so a quorum of two survives two failing at once. */
export const SOURCES: Source[] = [
  { id: 'cloudflare', label: 'Cloudflare', fetch: fetchCloudflare },
  { id: 'pages-date', label: 'the server clock', fetch: fetchPagesDate },
  { id: 'google', label: 'Google', fetch: fetchGoogle },
  { id: 'wikipedia', label: 'Wikipedia', fetch: fetchWikipedia },
]

export const SOURCE_LABELS: Record<SourceId, string> = {
  cloudflare: 'Cloudflare',
  'pages-date': 'the server clock',
  google: 'Google',
  wikipedia: 'Wikipedia',
  device: 'this device',
}
