# M4 — The real 60-minute soak

**Verdict: PASS.** The piece ran for a full, uninterrupted hour at its default
settings, grew from seed to full bloom, and then stopped. Zero console errors,
zero exceptions, zero failed frame fetches, memory flat, and nothing scheduled a
single animation frame after `t = 1`.

Nothing was compressed. The run is one real hour of wall-clock time.

---

## What was run

| | |
|---|---|
| URL | `http://127.0.0.1:8137/?duration=3600&seed=42` — the defaults. **No speed multiplier.** |
| Server | `node server.mjs` on the canonical port 8137 |
| Browser | Chrome 152.0.7977.83, `--headless=new`, 1600×1000, device scale 1 |
| Started | 2026-09-16 15:38:17 UTC |
| Ended | 2026-09-16 16:38:47 UTC (3600 s of run + a 30 s quiet hold afterwards) |
| Samples | 63, one per 60 s, plus two after `t = 1` |
| Raw data | `soak-log.txt` (human-readable), `soak-samples.jsonl` (one JSON row per sample), `soak-summary.json` (everything, including the full N8 frame-by-frame trace) |
| Harness | `soak-runner.mjs` + `cdp.mjs` — a dependency-free CDP client driving the real page |

**Headless was used deliberately.** The M3 gate was disturbed by an external
process minimising a visible window. A `--headless=new` instance has no window
for anything to touch, and the N8 backgrounding test was still performed against
a genuine `visibilityState: "hidden"` (see below), not a synthetic event.

No frozen file was modified. Checksums of `src/shared/glibc-rand.js`,
`src/shared/clock.js`, `src/ascii/bonsai.js`, `src/ascii/terminal.js`,
`tools/export-skeleton.mjs`, `blender/bonsai_growth.py` and `public/skeleton-*.json`
were taken before the run; all timestamps predate this session.

---

## 1. It ended in full bloom, and it stopped

Measured at `t = 1` and again 30 seconds later — identical both times:

```
clock.done               true
frame.done               true
t                        1
body[data-state]         held
timeline fill width      100%          (exactly; CF-1 is fixed)
ASCII                    STEP 512 / 512
Blender plate            FRAME 600 / 600, base image = frame-0599.jpg
plate state              held
rAF scheduled after t=1  0
frame cache              3 entries / 243 406 bytes
DOM nodes                283, then 283
```

`requestAnimationFrame` was wrapped at document-start so every call could be
counted. The counter read **208 857** at `t = 1` and **208 857** thirty seconds
later: **zero** frames were requested after the finale. Calls and fires are equal
(208 857 / 208 857), so nothing was left dangling either. Nothing loops, nothing
resets, nothing polls.

The screenshot `bloom-t1.00.png` shows both panels bloomed: the ASCII canopy full
of `&` leaf glyphs, the rendered bonsai in white blossom with fallen petals in the
pot, the rail on **BLOOM**, and the footer reading `t+60:00 / 60:00 · SEED 42 ·
BLOOMED · HELD`.

## 2. Memory did not grow

JS heap (`performance.memory`, Chrome started with `--enable-precise-memory-info`):

| | |
|---|---|
| First sample | **2.10 MB** |
| Median | **2.28 MB** |
| Peak | **2.89 MB** |
| Final | **1.73 MB** |
| Net change over the hour | **−380 KB** |

CDP's own `Runtime.getHeapUsage` agrees: 1.77 / 2.04 / 2.65 / 1.52 MB. The heap
sawtooths between roughly 1.7 and 2.9 MB for the whole hour with no upward trend,
and ends *below* where it started.

The frame cache is the thing that could have leaked, and did not. It held **6**
entries at the start, never exceeded **8**, and collapsed to **3** at bloom.
Across the hour it fetched **594** frames and evicted **591** — a genuine sliding
window, not an accumulating one. **0 failed fetches.**

DOM nodes went 116 → 283 and then stopped dead. That growth is the ASCII tree
itself: the terminal renders one coloured `<span>` run per branch segment, so a
bigger tree is more spans. It plateaus the moment growth stops, which is what a
non-leak looks like.

## 3. Drift

Elapsed time is the **runner's own wall clock**, taken outside the browser, so
this is a real comparison and not the page checking itself.

| | |
|---|---|
| Max drift | **1.275 × 10⁻⁵** in `t` = **45.9 ms** of model time in 3600 s |
| Mean drift | 21.4 ms of model time |
| One animation frame (16.7 ms) | 4.64 × 10⁻⁶ in `t` |
| One ladder frame (6 s) | 1.67 × 10⁻³ in `t` |
| Ever exceeded one **ladder** frame? | **No** — max drift was 0.8 % of one frame |
| Ever exceeded one **animation** frame? | **Yes**, from about the 20-minute mark onward |

**The honest answer on that last line: the drift is not the piece's.** It is this
machine's wall clock running fast against its own monotonic counter.

I ran an independent control for the last 46 minutes of the soak — a separate
Node process comparing `Date.now()` against `process.hrtime.bigint()`, which on
Windows reads the same QPC source Chrome's `performance.now()` uses
(`clock-skew-control.txt`). Fitted slopes:

```
soak drift slope     12.68 ppm
control skew slope   12.86 ppm      <- the machine's own clock, no browser involved
```

They agree to within 1.4 %. The Windows wall clock gained ~33 ms against the
monotonic counter over 43 minutes of measurement, and the soak's "drift" grew at
exactly that rate — including a visible dip at sample 37, which is where the OS
nudged its clock. Against the monotonic clock that both the browser and the
piece actually use, `GrowthClock` is exact by construction, and the measurement
confirms it.

Put plainly: after an hour the piece was **46 ms** away from a wall clock that had
itself moved 46 ms. That is 0.0013 % of the runtime and less than one hundredth
of a single ladder frame. It is not visible and it is not a defect.

Separately, **render lag** — the gap between the live clock and the `t` the panels
had last been handed — had a median of **8.8 ms** (half an animation frame) and a
maximum of **74 ms**. Both panels stayed on the playhead all hour.

## 4. Zero console errors for the entire hour

Counted from CDP, not from the page, across three channels:

```
console.error / console.assert   0
uncaught exceptions              0
browser log errors (incl. net)   0
console warnings                 0
browser log warnings             0
```

**Not one message of any kind was emitted in 3600 seconds.** The full (empty)
message list is in `soak-summary.json` under `errors.messages`.

## 5. N8 — hiding the tab (required mid-soak test)

Performed at **t + 1200 s**, exactly the 20-minute mark. The hide was real: a
second tab was opened in the same window and activated, and the page reported
`document.visibilityState === "hidden"`.

| | |
|---|---|
| `t` before hiding | **0.3333513** — ASCII step 170/512, plate frames 199/200 |
| Hidden for | **70.0 s** (the brief requires ≥ 60 s) |
| `t` on restore | **0.3540599** — ASCII step 181/512, plate frames 212/213 |
| Growth missed while hidden | **70.0 s** of model time |
| Max gap between rAF callbacks | **70 021 ms** |

That rAF gap is the proof the hide was genuine: animation frames really were
suspended for the entire 70 seconds, to within 5 ms of the hide duration. No
event was faked and the clock was not paused — 70 seconds away is 70 seconds of
growth, which is the correct semantics under N8.

Recovery, recorded frame-by-frame from the first restored animation frame:

- **Blank frames: 0 of 239** recorded animation frames. At every single sample a
  base image was present, `complete`, non-zero `naturalWidth`, and at opacity 1.
- **No visible snap.** The base frame went `200 → 211` as a 240 ms cross-dissolve,
  with the old frame held underneath at full opacity throughout — not a cut.
- **No "stalled" state.** The plate's state sequence was exactly
  `resyncing → ready`. The string "stalled" was never written.
- **The ASCII panel did not animate through the skipped steps.** On the *first*
  frame back (`+0.0 ms`) it was already on step **180**, which is exactly
  `floor(t × 512)` for the restored `t`. It re-rendered straight there inside the
  `visibilitychange` handler, before any paint.
- **Recovery time: 348 ms**, measured from the first restored frame to the frame
  on which the painted base is the frame the playhead wants, with no resync or
  dissolve outstanding.

The soak continued normally afterwards; sample 22, 75 seconds later, was back on
cadence with drift unchanged.

## 6. Screenshots

Full-page PNGs, 1582 × 904, captured at the five required points:

| File | `t` at capture | What it shows |
|---|---|---|
| `bloom-t0.00.png` | 0.0010 | Bare pot, empty canopy. STEP 001/512 · FRAME 001/600. Rail on SEED. |
| `bloom-t0.25.png` | 0.2501 | STEP 129/512 · FRAME 150/600. Rail on SAPLING/BRANCHING. |
| `bloom-t0.50.png` | 0.5002 | STEP 257/512 · FRAME 300/600. Rail on BRANCHING, fill exactly half. |
| `bloom-t0.75.png` | 0.7501 | STEP 385/512 · FRAME 450/600. Rail on MATURE. |
| `bloom-t1.00.png` | 1.0000 | Full bloom, both panels. STEP 512/512 · FRAME 600/600. Fill 100 %. |

The two trees sit at matching ground line and canopy height in all five.

---

## Things that went wrong, or are worth knowing

Reported because Fable will read the raw samples.

**1. Drift did exceed one *animation* frame, from roughly the 20-minute mark on.**
Peak 45.9 ms of model time. I chased it rather than waving it off, and the
independent clock-skew control (section 3) attributes essentially all of it —
12.68 ppm observed vs 12.86 ppm measured on the bare machine — to the Windows
wall clock, not the page. Against one *ladder* frame, which is what actually
governs what you see, the drift never got past 0.8 %. I am calling this a pass,
but I am flagging it rather than burying it: if you measure `t` against
`Date.now()` on a box whose clock is being disciplined by NTP, you will see this
number, and it is the host's, not the piece's.

**2. 44 long tasks over the hour, totalling 7.4 s, worst one 664 ms.** They are
not evenly spread — three clusters (6 at t+1620 s, 15 at t+3180 s, 9 at t+3420 s)
account for most of them, with long quiet stretches in between. They do not line
up with my screenshot captures or with any phase boundary, and the measured
consequence was small: median render lag stayed at 8.8 ms and the worst was
74 ms, roughly four animation frames, with no dropped state and no error. My
reading is host contention on a busy Windows machine (something else wanting the
CPU), not work the page created — but I did not prove that, so it is written down
as an observation rather than an explanation.

**3. `document.body[data-settled]` is `undefined` at the end.** The M3
backgrounding proof records `data-settled="true"` at the finale. In this run
`data-state="held"` was set correctly and everything else about the finale is
right, but `data-settled` never appeared. It may be set on a path this run did
not take. It is cosmetic — no behaviour depends on it — but it is a discrepancy
against an earlier proof and I am not going to pretend I did not see it.

**4. At the very first sample (t + 3.5 s) the plate briefly reported
`cacheHeld: 6` and frames `0/1`** while its prefetch window filled. This is the
warm-up, not a fault; the `t = 0` screenshot taken at the same moment already
shows the correct seed frame with no blank.

**5. A 90-second compressed preflight was run first** (`preflight-log.txt`,
`preflight-samples.jsonl`, `preflight-summary.json`, `preflight/*.png`) to prove
the harness itself — the hide mechanism especially — worked before spending the
hour. It is a harness test, kept for transparency. **The soak itself was not
compressed in any way.**
