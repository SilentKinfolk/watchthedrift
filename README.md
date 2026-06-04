# watchthedrift

**How many seconds is your watch off from real time — right now?**

Point your phone's camera at a [Casio F-91W](https://en.wikipedia.org/wiki/Casio_F-91W) and `watchthedrift` reads the displayed time, compares it against an internet (NTP-style) time reference at the exact moment of capture, and tells you the offset — e.g. **`+6 s (fast)`**.

🔗 **Live:** https://silentkinfolk.github.io/watchthedrift/

## Why

A quartz watch like the F-91W slowly drifts out of sync with real time. It's spec'd at ±30 s/month and real units typically run a handful of seconds a month — small enough that you never notice until it's well off and you're late (or early). This is a quick, zero-install way to check *exactly* how far off it is at this instant.

## How it works

1. **Camera** — live rear-camera preview with an alignment guide; capture a frame and timestamp the exact capture instant.
2. **Read** — the 7-segment digits are recognised on-device (OCR). If the read isn't confident, it asks you to retake — no guessing.
3. **Reference time** — an NTP-style time check over HTTPS with round-trip compensation pins "true" time to a few tens of milliseconds.
4. **Drift** — the displayed time minus true time, shown with an honest uncertainty band.

### A note on precision

A single photo can pin the offset to about **±0.5 s**, because the watch only displays whole seconds (when it shows `:15`, it's really somewhere in `15.0`–`16.0`). That's plenty to see you're several seconds off. A future refinement (watching the live video for the digit to tick over) can push this well below half a second.

### Privacy

All image processing happens **on your device**. The only network request is the time check. No photos are uploaded, and nothing is stored or logged — every measurement is ephemeral.

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

Early days — built iteratively.

- **v1 (in progress):** end-to-end camera → OCR → NTP → drift, deployed as an installable PWA.
- **Later:** a purpose-built F-91W segment decoder for higher reliability; sub-0.5 s accuracy via live tick detection; support for other digital watches.

Deliberately **out of scope:** storing history, logging, charts, or drift-rate tracking — this answers one ephemeral question and nothing more.

## License

[MIT](LICENSE)
