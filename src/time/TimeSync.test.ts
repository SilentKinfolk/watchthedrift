import { describe, it, expect } from 'vitest'
import { offsetFromSamples, corroborate, QUORUM, type Candidate, type RawSample } from './TimeSync'

const ORIGIN = 1_000_000

describe('offsetFromSamples', () => {
  it('selects the minimum-RTT sample', () => {
    const samples: RawSample[] = [
      // RTT 200, would imply skew +80
      { serverMs: ORIGIN + 200 + 80, floorMs: 1, t0: 100, t1: 300 },
      // RTT 40 (smaller), skew +50 → this one should win
      { serverMs: ORIGIN + 120 + 50, floorMs: 1, t0: 100, t1: 140 },
    ]
    const off = offsetFromSamples(samples, ORIGIN, 'timeapi')
    expect(off.skewMs).toBeCloseTo(50, 6)
    expect(off.uncertaintyMs).toBeCloseTo(40 / 2 + 1, 6) // rtt/2 + floor
    expect(off.id).toBe('timeapi')
  })

  it('adds the source floor to the uncertainty band', () => {
    const samples: RawSample[] = [{ serverMs: ORIGIN + 250 + 500, floorMs: 500, t0: 0, t1: 500 }]
    const off = offsetFromSamples(samples, ORIGIN, 'pages-date')
    expect(off.skewMs).toBeCloseTo(500, 6)
    expect(off.uncertaintyMs).toBeCloseTo(250 + 500, 6)
  })

  it('throws when given no samples', () => {
    expect(() => offsetFromSamples([], ORIGIN, 'timeapi')).toThrow()
  })
})

describe('corroborate', () => {
  const c = (id: Candidate['id'], skewMs: number, uncertaintyMs: number): Candidate => ({
    id,
    skewMs,
    uncertaintyMs,
  })

  it('rejects a falseticker that the rest of the pool contradicts', () => {
    // The 2026-08-03 failure: timeapi.io answered normally from a clock 1100.7 s
    // slow. Three honest sources agree within tens of ms and outvote it.
    const agreed = corroborate([
      c('timeapi', -1_100_744, 30),
      c('cloudflare', 12, 40),
      c('binance', -5, 60),
      c('pages-date', 60, 520),
    ])
    expect(agreed).not.toBeNull()
    expect(agreed!.sources).not.toContain('timeapi')
    expect(agreed!.sources).toEqual(expect.arrayContaining(['cloudflare', 'binance', 'pages-date']))
    // Point estimate comes from the tightest band, here Cloudflare's ±40 ms.
    expect(agreed!.primary).toBe('cloudflare')
    expect(agreed!.skewMs).toBeCloseTo(12, 6)
  })

  it('refuses to pick a winner when sources split', () => {
    // Two sources, minutes apart: nothing can say which one is right.
    expect(corroborate([c('cloudflare', 0, 50), c('timeapi', -1_100_744, 50)])).toBeNull()
  })

  it('refuses a single source, however tight its band', () => {
    expect(corroborate([c('cloudflare', 0, 1)])).toBeNull()
    expect(corroborate([])).toBeNull()
  })

  it('needs only QUORUM sources to agree', () => {
    const agreed = corroborate([c('cloudflare', 0, 40), c('pages-date', 200, 520)])
    expect(QUORUM).toBe(2)
    expect(agreed).not.toBeNull()
    expect(agreed!.sources).toHaveLength(2)
    expect(agreed!.primary).toBe('cloudflare')
  })

  it('accepts a coarse source whose wide band overlaps a tight one', () => {
    // pages-date is only good to ±500 ms; it must not be rejected for sitting
    // 400 ms away from a millisecond-resolution source.
    const agreed = corroborate([c('cloudflare', 0, 30), c('pages-date', 400, 520)])
    expect(agreed).not.toBeNull()
    expect(agreed!.sources).toHaveLength(2)
  })

  it('widens the reported band to cover every corroborating source', () => {
    // Cloudflare claims ±30 ms but pages-date sits 400 ms away, so ±30 ms would
    // understate what we actually know.
    const agreed = corroborate([c('cloudflare', 0, 30), c('pages-date', 400, 520)])
    expect(agreed!.uncertaintyMs).toBeCloseTo(400, 6)
    expect(agreed!.spreadMs).toBeCloseTo(400, 6)
  })

  it('prefers the larger agreeing set over a smaller one', () => {
    // Three sources agreeing must outvote a mutually-consistent pair a minute out.
    const agreed = corroborate([
      c('timeapi', 60_000, 40),
      c('device', 60_030, 40),
      c('cloudflare', 0, 40),
      c('binance', 5, 60),
      c('pages-date', 20, 520),
    ])
    expect(agreed).not.toBeNull()
    expect(agreed!.sources).toEqual(
      expect.arrayContaining(['cloudflare', 'binance', 'pages-date']),
    )
    expect(agreed!.sources).not.toContain('timeapi')
    expect(agreed!.skewMs).toBeCloseTo(0, 6)
  })

  it('refuses a tie between two equally-supported sets', () => {
    // Two pairs, a minute apart, each internally consistent. Nothing here says
    // which pair is right, so picking whichever sorted first would be a guess
    // dressed as a measurement.
    expect(
      corroborate([
        c('timeapi', 60_000, 40),
        c('device', 60_030, 40),
        c('cloudflare', 0, 40),
        c('pages-date', 20, 520),
      ]),
    ).toBeNull()
  })

  it('is independent of the order sources answered in', () => {
    const pool = [
      c('timeapi', -1_100_744, 30),
      c('cloudflare', 12, 40),
      c('binance', -5, 60),
      c('pages-date', 60, 520),
    ]
    const forward = corroborate(pool)!
    const reversed = corroborate([...pool].reverse())!
    expect(reversed.skewMs).toBeCloseTo(forward.skewMs, 6)
    expect(reversed.primary).toBe(forward.primary)
    expect([...reversed.sources].sort()).toEqual([...forward.sources].sort())
  })
})
