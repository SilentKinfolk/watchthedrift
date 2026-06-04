# watchthedrift — progress & pick-up notes

_Snapshot for resuming work. Live: https://silentkinfolk.github.io/watchthedrift/ · Repo: SilentKinfolk/watchthedrift_

## What this is
A single-screen web app: point a phone's rear camera at a Casio F-91W, read the
time off the face **on-device**, compare it to internet (NTP-style) time at the
moment of capture, and show how many seconds the watch is off — e.g. `+6 s (fast)`.
Ephemeral (no storage/history/logging), plain black-and-white UI, installable
later as a PWA.

## Status at a glance
| Piece | State |
| --- | --- |
| Hosting (GitHub Pages + Actions auto-deploy) | ✅ done |
| UI / single-screen state machine (B&W) | ✅ done |
| Camera capture (rear cam, 4K-ideal, timestamped) | ✅ done |
| NTP-style time sync (timeapi.io + fallbacks, RTT-compensated) | ✅ done, unit-tested |
| Drift maths (nearest-mod-period, 12h/24h, wrap) | ✅ done, unit-tested |
| Recognition (reading the digits) | 🟡 **in progress** — see below |
| PWA install/offline | ⏸ on hold (deliberately) |

**Important:** the *live app still calls the old Tesseract reader*, which is
unreliable, so a real measurement on a phone currently just asks you to "retake."
Camera + box *framing* work; *reading* will work once the new decoder is finished
and wired in (replacing `TesseractRecognizer`).

## How to run
```sh
npm install
npm run dev      # http://localhost:5173 — secure context, so the camera works
npm test         # Vitest (drift + time-sync + parser)
npm run build    # typecheck + production build → dist/
npm run harness  # run the segment decoder over tools/ images, save overlays to tools/out/
```
Deploy: push to `main` → GitHub Actions builds and publishes to Pages.

## Key files
- `src/ui/Screen.ts` — the single-screen state machine (idle/preview/measuring/result/retake/errors), `?debug=1` view, live `W/H` box controls.
- `src/camera/Camera.ts` — getUserMedia rear camera + frame capture/timestamp.
- `src/time/TimeSync.ts`, `src/time/sources.ts` — RTT-compensated offset; timeapi.io → Cloudflare → Date-header → device-clock chain.
- `src/drift/Drift.ts` (+ `.test.ts`) — signed offset, nearest difference mod 12h/24h.
- `src/recognize/`
  - `Recognizer.ts` — engine interface (swappable).
  - `TesseractRecognizer.ts` — current app engine (unreliable; being replaced).
  - **`segments.ts` — the new custom 7-segment decoder (primary engine, WIP).**
  - `binarize.ts` — grayscale + Otsu threshold (shared with harness).
  - `preprocess.ts` — crop + scale + binarise (browser).
  - `geometry.ts` — alignment-box / crop fractions.
  - `parse.ts` — OCR-text → HH:MM:SS (used by the Tesseract path).
- `tools/ocr-harness.ts` — headless harness; reads `tools/fixtures/` + `tools/local/` (both gitignored images), decodes, scores vs filename labels, writes annotated overlays to `tools/out/`.
- `.github/workflows/deploy.yml` — Pages deploy.

## The recognition engine (what + how)
**It is a hand-written, pure-TypeScript algorithm — no ML, no cloud, no API.** It
implements the classic seven-segment-OCR approach (à la `ssocr`), tailored to the
F-91W's fixed layout. `decodeSegments(binarisedPixels, w, h)` does:
1. **Binarise** the crop (Otsu) → black ink on white.
2. **Trim** the near-solid black bezel frame.
3. **Find the digit band** — the tallest horizontal band of ink = the big `HH:MM`.
4. **Split into cells** by column gaps → individual digits + the colon.
5. **Read each digit** by sampling its seven segment regions (each on/off by ink
   fraction) and mapping the 7-bit pattern to a digit via a lookup table.
6. **Assemble** `HH:MM:SS` using the colon as the anchor (after it = MM then SS).

**Current result:** the *segment-reading core works* — a clean front-on crop of
`19:45:08` decodes to `19:45:09` (one segment off), confidence ~0.72. The *fragile*
part is steps 2–4 (locating/cropping the digits): it's too sensitive to framing,
so grainy or loosely-framed or angled shots fragment or fail.

### Next session — the plan
1. **Make the front-end framing-robust.** Replace the column-gap splitting with a
   **colon-anchored, fixed-pitch layout**: find the colon + band, then place digit
   cells at the F-91W's known relative positions/pitch and sample them. Robust to
   broken segments and modest mis-framing.
2. Tune segment sample regions until the labelled set reads cleanly.
3. **Wire the decoder into the app** (a `SegmentDecoderRecognizer` implementing
   `Recognizer`), replacing Tesseract; keep Tesseract as a fallback.
4. If angled/perspective shots matter → add **OpenCV.js** for deskew/threshold.
   If we want it bulletproof → an **ML model** trained on Blender-rendered +
   real data (copyright-clean, varied angles/lighting).

### Why custom (build-vs-adapt, settled)
No browser-ready seven-segment OCR tool exists to adapt: `ssocr` is C with no WASM
port (and is generic — doesn't know the F-91W); the npm `seven-segment-display` only
*renders* a display; general OCR (Tesseract) fails because the segments aren't
connected. Our decoder is the standard approach, focused on one known device — the
lightest, most on-device-friendly option. OpenCV.js / ML are the escalation rungs.

## The harness & how the test images are labelled (important nuance)
- The **boxes + digit labels in `tools/out/*-decode.png` are drawn by *our code*** —
  the harness renders what `decodeSegments` detected (cell boxes, the digit it read).
  These are **not** produced by any AI/Claude model; they're the deterministic
  algorithm's output, visualised so we can see where it goes wrong.
- The **ground-truth labels** (the correct time baked into each filename, e.g.
  `..._19-45-08_24h.jpg`) were established by a human/Claude *reading* the photo once,
  purely to score the algorithm. That reading is **not part of the product** and never
  runs in the app — the app must do it all locally with the segment decoder.

## Deliberately out of scope
Storing history, logging, charts, drift-rate-over-time, manual digit entry, and
sub-second "tick detection" — this answers one ephemeral, whole-second question.
