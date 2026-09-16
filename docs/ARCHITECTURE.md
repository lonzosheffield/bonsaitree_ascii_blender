# Architecture

A map of the pipeline, for someone who wants to change it.

The governing constraints live in [`BRIEF.md`](BRIEF.md) (N1–N8 and addenda).
This document is how they are wired together. Where the two disagree, the brief
wins.

---

## The one idea

Two panels showing the same bonsai must be the *same tree*, not two trees that
look alike. Everything below exists to make that literally true:

```
cbonsai C source
      │  read, not run
      ▼
glibc TYPE_3 RNG (JS)  ──►  cbonsai port (JS)  ──►  skeleton JSON
                                   │                      │
                                   │                      ▼
                                   │               Blender rig ──► 600-frame ladder
                                   │                                     │
                                   ▼                                     ▼
                            ASCII panel  ◄──── GrowthClock ────►  browser scrubber
                                                (t ∈ [0,1])
```

`t` is the only thing the two panels share at runtime, and `skeleton-42.json` is
the only thing they share at build time. Neither panel can see the other.

---

## Stages

### 1 — `vendor/cbonsai/cbonsai.c` — the reference

The upstream C source, vendored. It is **read, not linked**. Line references
throughout `src/ascii/bonsai.js` point back into it.

The one thing it is *run* for is ground truth: `tools/Dockerfile.cbonsai` builds
the real binary under Debian/glibc with `COLUMNS=80 LINES=40` pinned, and
`tools/golden.sh` captures `cbonsai -p -s <seed>` for five seeds.

`cbonsai -p` does not emit clean text — it emits the whole ncurses stream, then
the `endwin()` teardown, then a per-cell SGR-coded grid dump. `golden.sh` cuts
the grid out deterministically, keeps the raw capture for audit, and writes the
colour codes to a separate artifact (they are the ground truth for the palette
check). See the N3 addendum in the brief, including the malformed `\033[3-1m`
quirk that any escape-stripping regex has to tolerate.

> **Docker is only needed to regenerate goldens.** The goldens are committed in
> `proof/M1/golden/`, so the test suite runs without it.

### 2 — `src/shared/glibc-rand.js` — the generator

glibc's `random()` is TYPE_3 additive feedback, degree 31, separation 3:

```
seed    r[0] = seed (0 → 1);  r[i] = (16807 · r[i-1]) mod 2^31-1   (Schrage)
warmup  discard 310 outputs
draw    r[i] = (r[i-31] + r[i-3]) mod 2^32   →   return r[i] >>> 1
```

A line-for-line port of `__srandom_r`/`__random_r`, verified byte-exact against
glibc 2.36 (`proof/M0/rand-match.txt`). Substituting any other PRNG — Mersenne
Twister, an LCG, `Math.random` — silently produces a different tree and makes
every downstream comparison meaningless.

### 3 — `src/ascii/bonsai.js` — the growth walk

A translation of cbonsai's recursive branch model. Three things carry the
fidelity, in descending order of how easy they are to get wrong:

1. **The order of `rand()` calls is part of the algorithm.** Recursive calls in
   `branch()` happen *before* the parent's own colour/string draws, exactly as
   in C. A correct generator consumed in the wrong order yields a different tree.
2. **`setDeltas()` is the tree's shape**, reproduced verbatim including the
   integer truncation in `(int)(multiplier * 0.5)`.
3. **Terminal geometry is an input.** stdscr is 40×80; the base art takes 4 rows,
   so `treeWin` is **36×80** and the trunk starts at `(y=35, x=40)`. Branch
   length, the ground clamp, and ncurses' edge clipping all depend on those
   numbers. Recursing against 40 rows produces a subtly taller tree whose failure
   looks like a branching bug.

It also emulates enough ncurses to be byte-exact: `wmove()` bounds checking,
right-margin wrap in `waddch()`, attribute bookkeeping, and the non-destructive
`overlay()` of base over tree.

The module exports a pure, seeded growth object — a list of steps, each the set
of cells `updateScreen()` would have shown after that iteration. It knows
nothing about time.

**Gate:** `tools/diff-fidelity.mjs` diffs the rendered 40×80 character grid
against the golden text for seeds 1, 42, 1337, 99999, 2147483647. Normalisation
is limited to line endings, trailing whitespace, and SGR removal from the
golden — nothing else.

### 4 — `tools/export-skeleton.mjs` — the bridge

```
node tools/export-skeleton.mjs --seeds 42,1337 --out public
```

**This file does not contain the growth algorithm.** It imports the frozen walk
and *observes* it. `GlibcRandom.prototype.rand` is monkey-patched at runtime to
capture a V8 structured stack trace on every draw, which yields the calling
function, the exact source line of each call site, and the live recursion stack —
enough to identify branch type, life band and spawn kind without re-implementing
anything. Call sites are located by searching the frozen source for unique
marker strings, so the tool fails loudly if `bonsai.js` ever changes shape rather
than quietly exporting nonsense. Geometry is read from the walk's own write log.

Output, `public/skeleton-<seed>.json`:

```json
{ "seed": 42, "cols": 80, "rows": 36, "maxLife": 32,
  "segments": [ { "id", "parent", "type", "x0","y0","x1","y1",
                  "life", "age", "birthStep", "depth" }, ... ] }
```

`birthStep` is the sync contract. It is the ASCII panel's own step index, so a
segment appearing in the render at step *n* appears in the character grid at
step *n*.

### 5 — `blender/bonsai_growth.py` — the rig

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" `
    --background --factory-startup --python blender\bonsai_growth.py -- `
    --skeleton public\skeleton-42.json --out public\frames --frames 600
```

Run it from **PowerShell, not Git Bash** (Git Bash returns "Permission denied"
on `blender.exe`). The EEVEE engine id in Blender 5.2 is `BLENDER_EEVEE`, not
the 4.x `BLENDER_EEVEE_NEXT`.

Coordinate mapping — the only thing 3D adds is depth:

```
grid x     → world X   (× COL_W)
grid y     → world Z   (up; ground row → Z = 0)
segment id → world Y   (depth, from hash32 of the id)
```

Properties that make it reproducible and gate-able:

- **No keyframes, drivers or F-curves exist in the file.** `build_tree(t)` tears
  down and rebuilds the branch/leaf/blossom datablocks for every frame. Frame *i*
  renders `t = i / (frames-1)` and nothing else about *i* is an input, so
  rendering frames 300–305 alone is pixel-identical to those frames inside a full
  run.
- **Nothing consults `random`.** Every "random" quantity is `hash32()` of an
  integer id. Same skeleton, same pixels, any machine, any order.
- **Growth is monotonic by construction**, not by inspection: every t-varying
  quantity is a product of non-negative non-decreasing factors.
- **The camera is built once**, before the render loop, from the skeleton's t=1
  bounds, and never touched. Camera drift would destroy the side-by-side illusion.

**Secondary maturation (N7).** cbonsai's growth is front-loaded and discrete — a
branch snaps into existence and is then finished forever. Over four seconds in a
terminal nobody notices; over an hour it is fatal, and the ASCII panel cannot fix
it because *its timing is the sync contract*. So this rig carries the continuity
for both, on channels the character grid does not have: per-site leaf maturation
clocks, cards unfurling (~4 → 8) to `MATURE_END`, foliage darkening from spring
flush to deep green, and wood thickening on an accelerating curve
(`THICKEN_GAMMA ≥ 1.4`) so girth is something the *second* half of the hour does.

**None of that may touch skeleton reach, chain birth steps or blossom timing.**
Those are the sync contract. Secondary maturation rides on top; it never rewrites.

**Acceptance test for any growth change:** pick any two consecutive frames in
`t ∈ [0.55, 0.87]`; whole-frame mean |Δ| must be ≥ 0.8/255. Monotonic is
necessary, not sufficient — a still image is perfectly monotonic.

**Cost:** ~7.2 s on heavy frames at 900×1200 / 48 samples, so 55–65 minutes for
600 frames. Render **sequentially in one `--background` session** — measured, three
concurrent processes ran at 29.1 s/frame each against 4.9 s/frame alone, a net
throughput loss. The integrated GPU is saturated by one EEVEE process. If wall
clock must come down, reduce `--res`; the frame count is fixed at 600 (N5).

### 6 — `public/frames/` — the ladder

600 JPEGs at 900×1200, ~58 KB each, plus `manifest.json` written by
`tools/ladder-integrity.py`: frame count, resolution, per-frame `t`, sha256 and
byte size. `bonsai.webm` is decorative and unused by the page.

Integrity is judged on **structure** (std, dynamic range, lit-pixel count), never
on mean luminance — the scene is a dark field, so a whole-frame mean of ~6/255 at
t=0 is correct exposure, not a black frame.

### 7 — the browser

```
index.html            shell, phase rail, timeline, alignment fit
src/shared/clock.js   GrowthClock — the single source of t
src/ascii/terminal.js left panel: 80×40 <pre>, cbonsai palette
src/blender/panel.js  right panel: JPEG ladder scrubber + crossfade
src/styles.css
server.mjs            zero-dependency static server, port 8137
```

**The clock.** `?duration=&speed=&seed=` (N6), defaults `3600 / 1 / 42`. Phases
are normalised spans: `seed` 0–0.08, `sapling` 0.08–0.28, `branching` 0.28–0.62,
`mature` 0.62–`BLOOM_START`, `bloom` `BLOOM_START`–1, where
`BLOOM_START = 1 − 480/3600` — the last eight minutes, exactly. The clock stops
itself at `t = 1`. Panels should `clock.subscribe()` rather than run their own
loop; `window.BonsaiDuet` exposes the same frame the shell renders from, and a
`bonsai:tick` CustomEvent is dispatched for anything that cannot take a module
import.

**Why the ladder and not a `<video>`.** A video seek snaps to the nearest
keyframe, so the sync measurement would be measuring the codec rather than the
growth. Swapping `<img>` frames is exact: `f = t·(frameCount−1)`, `lo = ⌊f⌋`,
`hi = min(lo+1, last)`, blend weight `frac = f − lo`.

**Why the crossfade is one-sided.** Fading A out while fading B in composites to
`f·B + (1−f)²·A + f(1−f)·P`, leaking 25% of the near-black backdrop at the
midpoint — a visible six-second strobe, for an hour. Instead the *base* layer is
always fully opaque and the *top* layer carries the whole blend. JPEG has no
alpha and both layers cover the identical rect, so the composite collapses to
`(1−frac)·lo + frac·hi`, an exact lerp with total coverage 1 at every `frac`.

**Why the prefetch window holds its own bytes.** The server sends
`Cache-Control: no-store` on everything (deliberate — files are edited under it
constantly), so the HTTP cache cannot serve as the prefetch buffer. The window
holds Blobs behind object URLs and `revokeObjectURL`s on eviction, which makes
release deterministic instead of heuristic. That is what keeps memory flat across
a real hour. Window size is derived from the clock's speed. Every layer swap
awaits `HTMLImageElement.decode()` while the layer is still transparent, so a
late frame cannot jank or flash.

**Backgrounding (N8).** The clock tracks wall-clock time, so returning after 20
minutes correctly shows 20 minutes of growth — that semantic must not be
"fixed" by pausing. What is handled is the *recovery*: on `visibilitychange →
visible` both panels recompute `t`, re-seat the prefetch window around the new
playhead, and hold the last good frame until the correct one has decoded. The
ASCII panel re-renders straight to the correct step instead of animating through
the skipped ones.

**Vertical alignment.** The ASCII tree occupies only the lower part of its 40-row
grid — cbonsai plants the trunk at row 35 and tops out near row 19, so rows 0–18
are permanently blank. That is faithful and must not be cropped or re-centred;
the 40-row geometry is load-bearing. The *Blender* framing is what adapts, so
both pot rims and both canopy tops land at the same viewport Y. `?guides=1` (or
**G**) overlays the measured landmark lines; `BonsaiDuet.alignment()` returns
what the fit solved.

---

## Frozen files

These passed their gates. The correspondence between the panels rests on them,
and a change to any one invalidates proof that took an hour of rendering or a
Docker round-trip to produce.

| File | Why it is frozen |
|---|---|
| `src/shared/glibc-rand.js` | Byte-exact against glibc. Any change reseeds every tree. |
| `src/shared/clock.js` | The single `t`. Both panels and every gate measure against it. |
| `src/ascii/bonsai.js` | Diffs clean against real cbonsai for 5 seeds. rand() call order is load-bearing. |
| `src/ascii/terminal.js` | Palette and cell-attribute contract verified against golden colour codes. |
| `tools/export-skeleton.mjs` | Observes the frozen walk by stack trace; coupled to `bonsai.js` line structure. |
| `blender/bonsai_growth.py` | Produced the committed ladder. Editing it desynchronises rig from frames. |
| `public/skeleton-*.json` | The build-time contract between the panels. |
| `public/frames/**` | ~60 minutes of render. Checksummed in `manifest.json`. |

`index.html`, `src/blender/panel.js` and `src/styles.css` are the presentation
layer and are the intended place to make changes.

---

## Changing things

| You want to… | Do this |
|---|---|
| Restyle the page | `src/styles.css`, `index.html`. Nothing downstream cares. |
| Change prefetch, crossfade or recovery behaviour | `src/blender/panel.js`. The ladder and manifest stay as they are. |
| Change phase boundaries or the default duration | `src/shared/clock.js` — but it is frozen, and the phase rail, the render's `BLOSSOM_START`, and every proof artifact are calibrated to the current values. Expect to re-gate. |
| Add a seed to the ASCII panel | Nothing to do — `?seed=` already works. The rendered panel will not match. |
| Add a seed to *both* panels | Export a skeleton, then re-render 600 frames for it (~60 min) into a second ladder, and teach `panel.js` to pick a manifest by seed. |
| Change the look of the 3D tree | `blender/bonsai_growth.py`, then a full re-render and `tools/ladder-integrity.py`. Apply the N7 acceptance test before believing it. |
| Regenerate goldens | Docker: build `tools/Dockerfile.cbonsai` with `vendor/cbonsai` as context, run `tools/golden.sh`. |

---

## Rebuild commands, in order

None of these are needed to *run* the piece.

```bash
# 1. goldens (needs Docker)
tools/golden.sh

# 2. fidelity gate
node tools/diff-fidelity.mjs

# 3. skeleton
node tools/export-skeleton.mjs --seeds 42,1337 --out public

# 4. render — PowerShell, one sequential session, ~60 min
#    see stage 5 above for the full invocation

# 5. manifest + integrity (needs Python 3 + Pillow/numpy)
python tools/ladder-integrity.py

# 6. run
npm start
```

Proof artifacts for each milestone live in `proof/M0` … `proof/M4`.
