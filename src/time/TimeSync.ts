// NTP-style time reference for the browser. We can't speak real NTP (UDP), so we
// estimate the offset between true UTC and the local monotonic clock
// (performance.timeOrigin + performance.now()) using round-trip-compensated
// HTTPS samples and NTP's trick of trusting the minimum-RTT sample.
//
// This module also implements NTP's *other* defence, which an earlier
// first-success chain omitted: a single server that is confidently wrong (a
// falseticker) must not be believed. On 2026-08-03 timeapi.io served well-formed
// JSON at ~170 ms RTT from a host clock 1100.7 s slow, and the chain took it and
// reported a ±86 ms band — an 18-minute error presented as high confidence.
// Sources are therefore sampled in parallel and an instant is believed only when
// the confidence bands of at least two independent sources contain it.

import {
  SOURCES,
  type Source,
  type SourceId,
} from './sources'

/** Added to each source's band before testing for overlap, absorbing the jitter
 *  between sources sampled a few hundred ms apart on a mobile link.
 *
 *  It is deliberately generous. Two millisecond-resolution sources are accepted up
 *  to 580 ms apart, and the same-origin `Date` header is only good to ±500 ms in
 *  the first place, so a tighter gate would reject honest sources and degrade the
 *  user to their unverified device clock — a worse outcome than a wide band. It
 *  cannot make the app overconfident: whatever disagreement survives the gate is
 *  carried into the reported uncertainty below. */
const AGREE_SLACK_MS = 250

/** Independent sources whose bands must contain a common instant. Two is the
 *  smallest number that can detect a falseticker at all. */
export const QUORUM = 2

/** An offset older than this is no longer trusted for a measurement: the page
 *  may have sat open for hours, and the device crystal drifts while it does. */
export const MAX_AGE_MS = 5 * 60_000

export type DegradeReason = 'no-sources' | 'no-quorum'

export interface TimeOffset {
  /** trueUtcMs = performance.timeOrigin + perfNow + skewMs. */
  skewMs: number
  /** Half-width of the confidence band, ms. */
  uncertaintyMs: number
  /** Sources whose bands corroborated this instant. */
  sources: SourceId[]
  /** Member of `sources` the point estimate was taken from (tightest band). */
  primary: SourceId
  /** Widest disagreement between corroborating sources, ms. */
  spreadMs: number
  /** True when we fell back to the unverified device clock. */
  degraded: boolean
  reason?: DegradeReason
  /** performance.now() when this offset was established, for staleness checks. */
  atPerf: number
}

export interface RawSample {
  serverMs: number
  floorMs: number
  /** performance.now() before the request. */
  t0: number
  /** performance.now() after the response was parsed. */
  t1: number
}

/** One source's verdict: where it thinks true UTC sits relative to our monotonic
 *  clock, and how tightly it can say so. */
export interface Candidate {
  id: SourceId
  skewMs: number
  uncertaintyMs: number
}

export interface Corroboration {
  skewMs: number
  uncertaintyMs: number
  primary: SourceId
  sources: SourceId[]
  spreadMs: number
}

/** Pick the minimum-RTT sample and derive the clock skew + uncertainty. */
export function offsetFromSamples(
  samples: RawSample[],
  timeOrigin: number,
  source: SourceId,
): Candidate {
  let best: RawSample | undefined
  for (const s of samples) {
    if (!best || s.t1 - s.t0 < best.t1 - best.t0) best = s
  }
  if (!best) throw new Error('offsetFromSamples: no samples')
  const rtt = best.t1 - best.t0
  const localMidMs = timeOrigin + (best.t0 + best.t1) / 2
  return {
    id: source,
    skewMs: best.serverMs - localMidMs,
    uncertaintyMs: rtt / 2 + best.floorMs,
  }
}

/** Find the largest set of sources that could all be right at once.
 *
 *  Each candidate asserts true UTC lies within [skew − band, skew + band]. Honest
 *  sources overlap; a falseticker's band sits minutes away and intersects nothing.
 *  Sweeping the interval endpoints for the instant covered by the most bands
 *  therefore yields the largest mutually-consistent set, and the result is
 *  independent of the order the sources answered in.
 *
 *  Returns null when no instant is covered by `QUORUM` sources — the honest
 *  outcome when sources disagree, since with a split we cannot say which is right. */
export function corroborate(
  candidates: Candidate[],
  slackMs: number = AGREE_SLACK_MS,
): Corroboration | null {
  if (candidates.length < QUORUM) return null

  const half = (c: Candidate): number => c.uncertaintyMs + slackMs
  const events: Array<{ at: number; delta: number }> = []
  for (const c of candidates) {
    events.push({ at: c.skewMs - half(c), delta: 1 })
    events.push({ at: c.skewMs + half(c), delta: -1 })
  }
  // Opens sort before closes at the same position, so bands that merely touch
  // still count as overlapping.
  events.sort((a, b) => a.at - b.at || b.delta - a.delta)

  // Record every instant that attains the maximum overlap, not just the first.
  let depth = 0
  let bestDepth = 0
  let peaks: number[] = []
  for (const e of events) {
    depth += e.delta
    if (e.delta !== 1) continue // an overlap can only begin where a band opens
    if (depth > bestDepth) {
      bestDepth = depth
      peaks = [e.at]
    } else if (depth === bestDepth) {
      peaks.push(e.at)
    }
  }
  if (bestDepth < QUORUM) return null

  const EPS = 1e-9
  const membersAt = (at: number): Candidate[] =>
    candidates.filter((c) => Math.abs(c.skewMs - at) <= half(c) + EPS)
  const key = (set: Candidate[]): string =>
    set
      .map((m) => m.id)
      .sort()
      .join(',')

  const members = membersAt(peaks[0])
  if (members.length < QUORUM) return null
  // Two equally-supported sets of sources, disagreeing with each other, leave us
  // no grounds to prefer either — the same reason a two-way split is refused. A
  // tie is not resolved by picking whichever sorted first.
  for (const at of peaks.slice(1)) {
    if (key(membersAt(at)) !== key(members)) return null
  }

  // Point estimate from the tightest member; band widened to reach every other
  // member, so the reported uncertainty covers the disagreement we can see.
  const primary = members.reduce((a, b) => (b.uncertaintyMs < a.uncertaintyMs ? b : a))
  const skews = members.map((m) => m.skewMs)
  return {
    skewMs: primary.skewMs,
    uncertaintyMs: Math.max(
      primary.uncertaintyMs,
      ...members.map((m) => Math.abs(m.skewMs - primary.skewMs)),
    ),
    primary: primary.id,
    sources: members.map((m) => m.id),
    spreadMs: Math.max(...skews) - Math.min(...skews),
  }
}

export interface SyncOptions {
  samples?: number
  timeoutMs?: number
}

export class TimeSync {
  private offset: TimeOffset | null = null
  private inFlight: Promise<TimeOffset> | null = null
  /** Every source's verdict from the last sync, corroborating or not (?debug). */
  private candidates: Candidate[] = []
  /** True when the last sync could not reach quorum but an earlier one had. */
  private lastSyncFailed = false

  /** Sample every source in parallel and store the corroborated offset. Always
   *  resolves. Concurrent calls share one in-flight sync.
   *
   *  A sync that fails to reach quorum does NOT discard a previously verified
   *  offset: a few-minute-old quorum-backed offset is worth far more than the
   *  unverified device clock, since the local crystal drifts by milliseconds over
   *  that span. We fall back to the device clock only when nothing was ever verified. */
  sync(opts: SyncOptions = {}): Promise<TimeOffset> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runSync(opts).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async runSync(opts: SyncOptions): Promise<TimeOffset> {
    const samples = opts.samples ?? 3
    const timeoutMs = opts.timeoutMs ?? 3000

    const results = await Promise.all(
      SOURCES.map((src) => this.sampleSource(src, samples, timeoutMs)),
    )
    this.candidates = results.filter((c): c is Candidate => c !== null)

    const agreed = corroborate(this.candidates)
    if (agreed) {
      this.lastSyncFailed = false
      this.offset = {
        skewMs: agreed.skewMs,
        uncertaintyMs: agreed.uncertaintyMs,
        sources: agreed.sources,
        primary: agreed.primary,
        spreadMs: agreed.spreadMs,
        degraded: false,
        atPerf: performance.now(),
      }
      return this.offset
    }

    this.lastSyncFailed = true
    if (this.offset && !this.offset.degraded) return this.offset

    this.offset = {
      skewMs: 0,
      uncertaintyMs: Number.POSITIVE_INFINITY,
      sources: [],
      primary: 'device',
      spreadMs: 0,
      degraded: true,
      reason: this.candidates.length === 0 ? 'no-sources' : 'no-quorum',
      atPerf: performance.now(),
    }
    return this.offset
  }

  /** Take `samples` round-trips off one source and reduce them to its verdict.
   *  Returns null if the source never answered. */
  private async sampleSource(
    src: Source,
    samples: number,
    timeoutMs: number,
  ): Promise<Candidate | null> {
    const raw: RawSample[] = []
    let failures = 0
    for (let i = 0; i < samples; i++) {
      try {
        const t0 = performance.now()
        const s = await src.fetch(AbortSignal.timeout(timeoutMs))
        const t1 = performance.now()
        raw.push({ serverMs: s.serverMs, floorMs: s.floorMs, t0, t1 })
      } catch {
        // Skip this sample. Bail early on a clearly dead source.
        if (++failures >= 2 && raw.length === 0) break
      }
    }
    if (raw.length === 0) return null
    return offsetFromSamples(raw, performance.timeOrigin, src.id)
  }

  get current(): TimeOffset | null {
    return this.offset
  }

  /** Every source's verdict from the last sync, including rejected ones. */
  get lastCandidates(): Candidate[] {
    return this.candidates
  }

  /** True when we hold a quorum-backed offset (however old). */
  get verified(): boolean {
    return this.offset !== null && !this.offset.degraded
  }

  /** True when the last sync attempt could not reach quorum. */
  get staleCheck(): boolean {
    return this.lastSyncFailed
  }

  /** Age of the current offset in ms, or null if we have none. */
  ageMs(): number | null {
    return this.offset ? performance.now() - this.offset.atPerf : null
  }

  /** An offset we should re-check before trusting it for a measurement. */
  isStale(maxAgeMs: number = MAX_AGE_MS): boolean {
    const age = this.ageMs()
    return age === null || age > maxAgeMs
  }

  /** Re-sync only when the current offset has aged out. `opts` bounds how long
   *  the caller is prepared to wait, which matters when a user is standing there
   *  with the camera up and the network is dead. */
  async refreshIfStale(
    maxAgeMs: number = MAX_AGE_MS,
    opts: SyncOptions = {},
  ): Promise<TimeOffset | null> {
    if (!this.isStale(maxAgeMs)) return this.offset
    return this.sync(opts)
  }

  /** Map a capture-instant performance.now() value to true UTC + its band. */
  trueUtcAt(perfNow: number): { epochMs: number; uncertaintyMs: number } {
    if (!this.offset) throw new Error('TimeSync: call sync() first')
    return {
      epochMs: performance.timeOrigin + perfNow + this.offset.skewMs,
      uncertaintyMs: this.offset.uncertaintyMs,
    }
  }
}
