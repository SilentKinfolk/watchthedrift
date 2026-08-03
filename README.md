# watchthedrift

**How many seconds is your watch off from real time — right now?**

Point your phone's camera at a [Casio F-91W](https://en.wikipedia.org/wiki/Casio_F-91W) and `watchthedrift` reads the displayed time, compares it against an internet (NTP-style) time reference at the exact moment of capture, and tells you the offset — e.g. **`+6 s (fast)`**.

🔗 **Live:** https://silentkinfolk.github.io/watchthedrift/

## Why

A quartz watch like the F-91W slowly drifts out of sync with real time. It's spec'd at ±30 s/month and real units typically run a handful of seconds a month — small enough that you never notice until it's well off and you're late (or early). This is a quick, zero-install way to check *exactly* how far off it is at this instant.

## How it works

1. **Camera** — live rear-camera preview with a small alignment box. Line the time row (HH:MM:SS) up inside it, a hand's width away so it stays in focus.
2. **Read** — a purpose-built F-91W seven-segment decoder reads the LCD inside the box on-device (cropping tight to the row keeps the binarisation clean, instead of a bright background throwing it off). It scans frames continuously and locks the instant two consecutive reads agree (so a stray misread is discarded), timestamping the exact moment of the winning frame.
3. **Reference time** — an NTP-style time check over HTTPS with round-trip compensation pins "true" time to a few tens of milliseconds. Four independent sources are queried in parallel and an instant is trusted only where at least two of them agree, so a single server with a wrong clock is outvoted rather than believed. The status line names the sources it used and how closely they agreed.
4. **Drift** — the displayed time minus true time, shown with an honest uncertainty band.

### Why the reference is cross-checked

On 3 August 2026 `timeapi.io` — then the sole source — served well-formed JSON at a healthy round-trip from a host whose clock was set **18 min 21 s slow**, and the app reported that as true time with a ±86 ms confidence band. Nothing a client can see distinguishes a confidently wrong clock from a right one: the HTTP status, the response shape and the round-trip time were all normal, and uptime monitors listed the service as up.

Round-trip time measures network latency and says nothing about whether a server's clock is correct, so a single source's word is not evidence. The app now believes an instant only where independent sources corroborate it, widens its stated uncertainty to cover their disagreement, and falls back to the device clock — clearly marked as unverified — when they cannot agree. The reference is also re-checked once it ages past five minutes, when the tab is brought back to the foreground, and before every scan, so a page left open does not measure against a stale offset.

### A note on precision

The watch shows whole seconds, so the answer is to the nearest second — which is all you need to decide whether to nudge it. (The midpoint of the displayed second is used, so a correctly-set watch reads `0 s` rather than appearing half a second slow.) You'll only see a margin of error if the app can't reach a reliable time reference — in which case it tells you.

### Privacy

All image processing happens **on your device**. The only network requests are the time checks. No photos are uploaded, and nothing is stored or logged — every measurement is ephemeral.

## Development

```sh
npm install
npm run dev        # http://localhost:5173 (a secure context, so the camera works)
npm test           # unit tests (Vitest)
npm run build      # type-check + production build to dist/
```

> The camera (`getUserMedia`) only works over HTTPS or on `localhost`. To test on a phone against your dev machine, use the deployed URL or run Vite with HTTPS.

## Deployment

Pushing to `main` builds the site and deploys it to GitHub Pages via the workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## Status & roadmap

Built iteratively.

- **Working & live:** point-and-catch live scan → custom on-device F-91W segment decoder → corroborated NTP-style time check → drift, deployed to GitHub Pages.
- **In progress:** reliability in dim light — the reflective LCD has no backlight, so it's hard to spot when it isn't bright; plus angled/perspective shots.
- **Later:** installable PWA / offline use; support for other digital-watch models.

Deliberately **out of scope:** storing history, logging, charts, or drift-rate tracking — this answers one ephemeral question and nothing more.

## License

[MIT](LICENSE)
