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
| Camera capture (rear cam, 1080p, timestamped) | ✅ done |
| NTP-style time sync (timeapi.io + fallbacks, RTT-compensated) | ✅ done, unit-tested |
| Drift maths (nearest-mod-period, 12h/24h, wrap) | ✅ done, unit-tested |
| Recognition (reading the digits) | 🟡 **auto-detects & reads clean shots; live on-device** — see below |
| PWA install/offline | ⏸ on hold (deliberately) |

**Status of reading:** the custom F-91W segment decoder is the engine, and it now
**auto-detects the LCD** anywhere in the frame — no alignment box. It binarises,
collects the largest bright (non-ink) regions as candidate panels, decodes each,
and keeps the one that yields a valid `HH:MM:SS`; bright background/walls/windows
are rejected because only the real display decodes. So the app feeds it the whole
(downscaled) capture and the user just points at the watch. Confirmed on the
harness by feeding **full-frame** watch photos (watch + strap + background): it
locks onto the LCD with no crop. Same read rate as before on the fixtures (the
clean front-on shots), since the leftover misses are pre-existing: faint/degraded
segments, the small seconds-units digit, and angled/perspective shots (see "Known
limits"). All fail *safe* (retake) except a genuinely-faint segment that can read
as a confident off-by-one. `?debug=1` shows the detected LCD — cropped and
locally binarised, with its band/cell boxes — plus the colour scene, so failures
are easy to read off.

Tesseract is **no longer wired in**: it can't read a full-frame capture (it OCRs
the whole image, not the located display), and running it as a fallback would
only add a wasm-load delay before an inevitable retake. `TesseractRecognizer` +
`CascadeRecognizer` are kept in the tree for a *better* future fallback — running
Tesseract on the decoder's **detected LCD crop** (`debug.lcd`). Dropping it from
the bundle also cut it from ~38 kB to ~19 kB.

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
  - **`segments.ts` — the custom F-91W 7-segment decoder (the algorithm; primary).**
    Pure, shared with the harness; takes the raw crop and owns binarisation.
  - **`SegmentDecoderRecognizer.ts` — wraps `segments.ts` as the primary `Recognizer`.**
  - `CascadeRecognizer.ts` / `TesseractRecognizer.ts` — **currently unwired.** Kept
    for a possible future fallback: run Tesseract on the decoder's *detected* LCD
    crop (`debug.lcd`) when the segment read fails.
  - `binarize.ts` — `toGray` + Otsu (shared by the decoder and `preprocess`).
  - `overlay.ts` — shared decode-overlay renderer (harness PNGs + app `?debug=1`).
  - `preprocess.ts` — crop + scale (down to ≤1600 px longest side) + binarise.
  - `geometry.ts` — the capture region (`TIME_CROP`): now a large, forgiving
    fraction of the frame, not a tight align box.
  - `parse.ts` — OCR-text → HH:MM:SS (Tesseract-path helper; idle while unwired).
- `tools/ocr-harness.ts` — headless harness; reads `tools/fixtures/` + `tools/local/` (both gitignored images), decodes, scores vs filename labels, writes annotated overlays to `tools/out/`.
- `.github/workflows/deploy.yml` — Pages deploy.

## The recognition engine (what + how)
**It is a hand-written, pure-TypeScript algorithm — no ML, no cloud, no API.** It
implements the classic seven-segment-OCR approach (à la `ssocr`), tailored to the
F-91W's fixed layout. `decodeSegments(rgba, w, h)` takes the **whole frame** and
owns all binarisation:
1. **Global Otsu** over the whole frame → a coarse ink mask used *only to locate*
   bright regions (dark digits AND dark case/bezel become ink).
2. **Auto-detect candidate LCDs** = the largest connected *bright* (non-ink)
   regions. The bezel and digits are both dark, so we anchor on the bright LCD
   background, not a "black frame"; bright things elsewhere just become extra
   candidates. **Crop to each candidate and re-binarise that crop with its own
   local Otsu** — so the digits separate cleanly from the LCD background, free of
   the dark watch body that skews a whole-frame threshold — then run steps 3–6.
3. **Find the digit band** — the tallest horizontal band of ink = the big `HH:MM`.
4. **Split into cells** by column gaps → individual digits + the colon.
5. **Read each digit** by sampling its seven segment regions (each on/off by ink
   fraction) and mapping the 7-bit pattern to a digit via a lookup table.
6. **Assemble & verify** `HH:MM:SS` (colon as anchor). Keep the candidate with the
   highest-confidence valid in-range time — only the real display produces one, so
   non-LCD candidates are rejected here. That decode-to-verify step is what lets
   framing be free: point at the watch, no box.

(We also tried OR-ing an adaptive local threshold into step 1 to recover faint
segments, but the F-91W LCD's faint background mottling reads as speckle under any
setting aggressive enough to help — global Otsu is simpler and more reliable.)

**Current result:** auto-detect validated on the harness by feeding **full-frame**
photos (watch + strap + background): it locks onto the LCD with no crop and reads
every clean front-on shot (e.g. `15:53:08`, `14:37:51`, conf ~0.71). Misses left
(all pre-existing, none from auto-detect):
- a **genuinely faint/degraded segment** (`19:45:08`→`09`): no ink there to read —
  unrecoverable by thresholding; on a real watch this is a retake.
- the **small seconds-units digit** under tight 12h framing (`5051`): column-gap
  splitting sizes the tiny seconds cell inconsistently → returns *no reading* (safe
  retake), not a wrong one.
- **angled / perspective** shots (`cand-1`): the segment sample regions don't align
  on a skewed glyph.

### Next steps
1. **On-device pass (the real iteration).** Just point at the watch — no alignment.
   With `?debug=1` the binarised frame is overlaid with the auto-detected
   LCD/band/cell boxes + the decode string, so failures are easy to diagnose. Tune
   the candidate filters / segment constants in `segments.ts` from what real photos
   show. (`?debug=1` still exposes `W/H` to shrink the capture region if a bright
   background nearby ever distracts detection — rarely needed.)
2. **Seconds robustness** (the main accuracy gap for drift): make the small
   seconds cells robust — e.g. snap them to a consistent height/baseline, or the
   originally-planned **colon-anchored fixed-pitch** layout for the whole row.
3. **Angled shots** → **OpenCV.js** deskew/perspective-correct before decode.
4. **Bulletproof** → an **ML model** (Blender-rendered + real, varied
   angles/lighting) — would also handle faint/degraded segments by context.

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
