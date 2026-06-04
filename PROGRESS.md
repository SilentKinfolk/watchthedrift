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
| Recognition (reading the digits) | 🟡 **works on clean front-on shots; wired into the app** — see below |
| PWA install/offline | ⏸ on hold (deliberately) |

**Status of reading:** the custom F-91W segment decoder is now the **primary
engine in the live app** (`SegmentDecoderRecognizer`, with `TesseractRecognizer`
behind it as a lazy fallback via `CascadeRecognizer`). The front-end is now
**LCD-anchored** (locks onto the bright LCD panel, so the dark case/bezel and
loose framing no longer break it) — this took the harness from 0/7 to reading
every clean front-on shot. Remaining misses are faint/degraded segments, the
small seconds-units digit under tight framing, and angled/perspective shots
(see "Known limits"). Those fail *safe* (retake), except a genuinely-faint
segment that can read as a confident off-by-one — needs a clear retake on a real
watch. Next real iteration is **on-device** with `?debug=1` (now shows the
decoder's LCD/band/cell boxes over the binarised crop).

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
  - `CascadeRecognizer.ts` — runs engines in order (decoder → Tesseract), first
    confident read wins; the app uses this.
  - `TesseractRecognizer.ts` — now the lazy fallback (wasm loads only if reached).
  - `binarize.ts` — `toGray` + Otsu (used by the decoder and the Tesseract preprocess).
  - `overlay.ts` — shared decode-overlay renderer (harness PNGs + app `?debug=1`).
  - `preprocess.ts` — crop + scale + binarise (debug view + Tesseract input).
  - `geometry.ts` — alignment-box / crop fractions.
  - `parse.ts` — OCR-text → HH:MM:SS (used by the Tesseract path).
- `tools/ocr-harness.ts` — headless harness; reads `tools/fixtures/` + `tools/local/` (both gitignored images), decodes, scores vs filename labels, writes annotated overlays to `tools/out/`.
- `.github/workflows/deploy.yml` — Pages deploy.

## The recognition engine (what + how)
**It is a hand-written, pure-TypeScript algorithm — no ML, no cloud, no API.** It
implements the classic seven-segment-OCR approach (à la `ssocr`), tailored to the
F-91W's fixed layout. `decodeSegments(rgba, w, h)` takes the **raw crop** and owns
all binarisation:
1. **Binarise** with global Otsu → dark digits AND dark case/bezel become ink.
2. **Isolate the LCD** = the largest connected region of *bright* (non-ink) pixels.
   This is the key idea: the bezel and the digits are both dark, so we can't trim a
   "black frame"; instead we anchor on the bright LCD background, which excludes the
   surround no matter how the watch is framed. Decoding is confined to that box.
3. **Find the digit band** — the tallest horizontal band of ink = the big `HH:MM`.
4. **Split into cells** by column gaps → individual digits + the colon.
5. **Read each digit** by sampling its seven segment regions (each on/off by ink
   fraction) and mapping the 7-bit pattern to a digit via a lookup table.
6. **Assemble** `HH:MM:SS` using the colon as the anchor (after it = MM then SS).

(We also tried OR-ing an adaptive local threshold into step 1 to recover faint
segments, but the F-91W LCD's faint background mottling reads as speckle under any
setting aggressive enough to help — global Otsu is simpler and more reliable.)

**Current result:** every **clean front-on** shot in the harness now reads
correctly (e.g. `15:53:08`, `14:37:51`, conf ~0.71); the harness went 0/7 → 3/7,
where the 3 are exactly the front-on labelled shots. The decoder is wired into the
app as the primary engine. Misses left:
- a **genuinely faint/degraded segment** (`19:45:08`→`09`): no ink there to read —
  unrecoverable by thresholding; on a real watch this is a retake.
- the **small seconds-units digit** under tight 12h framing (`5051`): column-gap
  splitting sizes the tiny seconds cell inconsistently → returns *no reading* (safe
  retake), not a wrong one.
- **angled / perspective** shots (`cand-1`): the segment sample regions don't align
  on a skewed glyph.

### Next steps
1. **On-device pass (the real iteration).** Open the live app with `?debug=1`: it
   now overlays the decoder's LCD/band/cell boxes on the binarised crop. Use the
   live `W/H` controls to size the alignment box to the time band, and read the
   decode string. Tune `TIME_CROP` defaults and the segment constants in
   `segments.ts` from what real photos show.
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
