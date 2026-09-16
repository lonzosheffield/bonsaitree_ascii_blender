# Bonsai Duet — Master Brief

**Every agent reads this file first. It is the contract. Fable QA gates against it.**

One locally-served page. Two panels. One clock. At `t=0` both sides are a seed;
at `t=3600s` both hold at full bloom and stop.

```
┌─────────────────────────────┬─────────────────────────────┐
│  cbonsai — ASCII            │  Blender — rendered         │
├─────────────────────────────┴─────────────────────────────┤
│ seed ─── sapling ─── branching ─── mature ─── BLOOM       │
│ ████████████████░░░░░░░░  t+37:12 / 60:00                 │
└───────────────────────────────────────────────────────────┘
```

---

## Non-negotiables

These were specified by the user. An agent that violates one fails its gate.

### N1 — glibc `random()` TYPE_3, not a generic PRNG
`vendor/cbonsai/cbonsai.c:1062` calls `srand(conf.seed)` and uses bare `rand()`.
glibc's `rand()` is the **TYPE_3 additive-feedback generator**, state size 31:

```
r[i] = (r[i-3] + r[i-31]) mod 2^32      output: r[i] >> 1
```

seeded by `r[0]=seed; r[i] = (16807 * r[i-1]) % 2147483647` (Lehmer, with the
signed-overflow correction), then **discard the first 310 outputs**.

**Do NOT use Mersenne Twister, an LCG, `Math.random`, or any npm PRNG.**
A wrong generator means the same seed yields a different tree and the M1 pixel
diff is meaningless. This is ~30 lines. Write it, then unit-test it against
values produced by real glibc inside the Docker container.

### N2 — Terminal geometry is an input to the algorithm
Branch length and tree shape are functions of the ncurses window size. The
golden run and the browser must use **identical dimensions**. Canonical:
`COLUMNS=80 LINES=40`, pinned in Docker, and the `<pre>` grid must be exactly
80×40 cells. Any mismatch invalidates the diff.

### N3 — Golden output is `cbonsai -p`
Use print mode (`vendor/cbonsai/cbonsai.c:948`): `cbonsai -p -s <seed>` writes
plain text to stdout, no animation, no ncurses screen control. Trivial to diff.
Do not attempt to scrape a live TUI.

### N4 — Video scrubbing needs keyframes everywhere
Default VP9 keyframe spacing is long, so `currentTime = t * duration` snaps to
the nearest keyframe and the M3 sync gate fails for reasons unrelated to growth.
Therefore:
- The **JPEG frame ladder is the primary scrub source.** The browser swaps
  `<img>` frames. This is exact by construction.
- The WebM is **decorative/optional**, and if produced at all must be encoded
  `-g 1` (keyframe every frame).

### N5 — 600 frames, with crossfade
120 frames over 3600s is one frame per 30s and reads as a slideshow beside a
live ASCII panel. Render **600 frames** (one per 6s — still cheap in EEVEE) and
**crossfade the two nearest frames** in the browser so motion is continuous.

### N6 — The clock is parameterized
`?duration=<seconds>&speed=<multiplier>&seed=<int>`. Default 3600s.
This is what makes autonomous QA possible: agents verify a 60-*second*
compressed run; only M4 spends a real hour. Growth must be a pure function of
normalized `t ∈ [0,1]` — never of wall-clock or frame count directly.

---

## Architecture

```
src/shared/clock.js      GrowthClock — single source of t ∈ [0,1]
src/shared/glibc-rand.js TYPE_3 additive feedback (N1)
src/ascii/bonsai.js      cbonsai algorithm port, pure, seeded
src/ascii/terminal.js    80×40 <pre> renderer, cbonsai palette
src/blender/panel.js     JPEG ladder scrubber + crossfade (N4, N5)
blender/bonsai_growth.py headless procedural rig, growth = f(t)
public/frames/           600 rendered JPEGs + manifest.json
proof/M<n>/              artifacts Fable judges
```

**Left panel:** faithful JS port of the recursive branch model — branch types
`trunk / shootLeft / shootRight / dying / dead` (`cbonsai.c:23`), the `setDeltas`
growth rules (`cbonsai.c:289`), leaf strings, base art, and the cbonsai palette.
Driven by our clock, not cbonsai's own step loop.

**Right panel:** build-time headless render. `blender --background --python
blender/bonsai_growth.py` builds a bonsai whose geometry is a function of `t`
(trunk girth, branch extension, leaf count/scale, blossoms emerging over the
final ~8 minutes of model time), renders 600 EEVEE frames, ffmpeg produces the
JPEG ladder. Browser scrubs; it never plays.

**Hardware note:** Intel Xe/Arc, driver 32.0.101.8826, 14 cores. A GL context
exists so EEVEE in `--background` should work. If EEVEE fails to acquire a
context, fall back to Cycles on CPU and **reduce resolution before reducing
frame count** — N5 is non-negotiable, resolution is not.

---

## Milestones & gates

| # | Build | Fable must see proof of |
|---|---|---|
| M0 | Scaffold, `GrowthClock`, page shell, `npm start` | Cold boot on clean checkout; clock exact at t=0/0.5/1.0; zero console errors |
| M1 | glibc RNG, cbonsai port, terminal panel | RNG unit-tested vs. real glibc; `cbonsai -p -s N` golden text diffs clean against JS render at 80×40 for ≥5 seeds; same seed twice → identical |
| M2 | Blender install, growth rig, render, ladder | Manifest: 600 frames, checksums, no black/dupe frames; contact sheet at 0/25/50/75/100%; growth monotonic |
| M3 | Integration, sync, bloom finale, polish | Sync delta <1 frame at 10 sample points; both bloom together; crossfade smooth; Fable judges aesthetics, not just correctness |
| M4 | One-command deploy, 60-min soak, README | Uninterrupted real hour: memory flat, no drift, ends bloomed and **stopped**; README followed literally from cold |

### Gate protocol
Fable runs in a **fresh context**. It sees this brief, the acceptance criteria,
and `proof/M<n>/` — never the conversation that produced the work. It returns
`PASS` or `FAIL` plus written remediation instructions. FAIL dispatches a fix
agent, then re-QA. **Two remediation rounds maximum**, then escalate to the user
rather than looping.

Nothing leaves a gate without proof. "It works on my machine" is not proof;
a screenshot, a checksum, a clean diff, and a console dump are.

---

## Measured Blender facts (verified on this machine — do not re-litigate)

Blender **5.2.1 LTS** installed at
`C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`.

- **Invoke it from PowerShell, not Git Bash.** Git Bash returns "Permission denied"
  on the exe. Use: `& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
  --background --factory-startup --python <script.py> -- <args>`
- **The EEVEE engine ID in 5.2 is `BLENDER_EEVEE`** — NOT `BLENDER_EEVEE_NEXT`.
  That identifier changed; using the 4.x name raises an enum error.
- **EEVEE works in `--background`.** The Intel Xe GL context is acquired
  successfully. Cycles fallback is NOT needed.
- **Measured render cost at 960x960:** first frame ~9.5s, second ~16.5s (shader
  compilation completing), then steady state **~4.9s/frame**. Budget ~49 minutes
  for the full 600-frame sequence. This is a ONE-TIME BUILD COST, not runtime.

### RENDER SEQUENTIALLY IN A SINGLE BLENDER SESSION

Measured, not assumed: 3 concurrent Blender processes rendered at **29.1s/frame
each** versus 4.9s/frame for one process alone. The integrated GPU is fully
saturated by a single EEVEE process, so parallelism costs ~6x per frame to buy
3x concurrency — a net throughput LOSS of about 2x.

**Do not chunk the render across cores or processes.** Render all 600 frames in
one `--background` session so shaders compile exactly once. If you think you
have found a way to parallelize this, you have not; re-read this paragraph.

If wall-clock must come down, reduce RESOLUTION (N5 fixes the frame count at 600,
and resolution is explicitly the thing that may be traded).

---

## N3 addendum — the real format of `cbonsai -p` output (verified from source)

`cbonsai -p` does **NOT** emit clean plain text. Verified by reading
`vendor/cbonsai/cbonsai.c`. What actually lands on stdout, in order:

1. The **full ncurses animation stream** — alternate-screen enter (`\033[?1049h`),
   cursor positioning (`\033[19;38H`), clears (`\033[2J`), etc. Print mode still
   runs the whole growth animation through ncurses first.
2. The **`endwin()` teardown escapes** — `finish()` at line 1081 calls `endwin()`
   (line 129) BEFORE dumping the grid.
3. **Then** `printstdscr()` (line 719) dumps the final grid.

### The grid format from printstdscr()
It loops `y` over `maxY` rows and `x` over `maxX` cols and, **for every single
cell**, prints SGR codes and then the character:
- `\033[1m` if bold, else `\033[0m` (line 741-742)
- then a color: `\033[0m` if fg==0, `\033[38;5;<n>m` if fg>=16,
  `\033[3<n>m` if fg<=7, `\033[9<n>m` if fg>=8 (lines 745-748)
- then the wide char, and a `\n` after the last column of each row (line 754)

**Known quirk:** when fg is -1 (terminal default), line 747 formats as
`\033[3-1m` — a malformed SGR. It appears constantly in the golden files. It is
NOT corruption and NOT a harness bug. Any escape-stripping regex must handle it;
a strict `\033\[[0-9;]*m` will MISS it because of the `-`. Use a tolerant
pattern such as `\033\[[0-9;?-]*[a-zA-Z]`.

### Therefore the golden extraction MUST
- Discard everything before the final `endwin()` teardown, then take the LAST
  `maxY` (40) lines. Do not diff the raw capture — a raw `seed-42.txt` measures
  ~3526 columns wide, which is escape bloat, not a grid.
- Strip SGR to recover the **character grid**: exactly 40 lines x 80 chars.
- Keep the color codes in a SEPARATE artifact — they are the ground truth for
  the palette check in the terminal renderer, so do not throw them away.

The M1 fidelity diff compares the STRIPPED 80x40 character grid. Comparing raw
captures will fail for reasons that have nothing to do with the port.

---

## Environment decision — canonical port is 8137, NOT 8080

Port 8080 on this machine is permanently held by an unrelated user process
(`family-hub`, PID 5480). **Do not kill it, do not ask the user to kill it, and
do not "free up" 8080.** The canonical port is now **8137** (verified free), set
as the default in `server.mjs`. `PORT=<n>` still overrides.

`server.mjs` now also treats **EACCES** as a port-unavailable condition, because
Windows reports an already-bound port as EACCES rather than EADDRINUSE — the
original handler only caught EADDRINUSE and died with a raw stack trace.

## Carry-forward defects (found at the M0 gate, fix during M3)

**CF-1 — timeline fill can skip the final frame.** In `index.html`'s `render()`,
the guard `Math.abs(pct - lastPct) > 0.01` suppresses the last update, leaving
the progress fill stuck at ~99.992% while the page is held at bloom. Force the
update when `frame.done` is true. This matters: the whole piece ends on t=1, and
a bar that never visibly reaches 100% undercuts the finale.

## N2 addendum — the tree window is 36 rows, not 40

Verified at the M0 gate by running `cbonsai -p -v -s 1` in the container, which
self-reports:

```
maxX: 080
maxY: 036
```

The terminal is 80x40, but the **treeWin ncurses window is 80x36** — the bottom
4 rows belong to the base art. Since branch length and shape are functions of
the WINDOW size (N2), the growth algorithm must be driven by **36 rows**, not 40.

A port that recurses against a 40-row window produces a subtly taller, wrongly
proportioned tree that will never diff clean, and the failure looks like a
branching bug rather than a geometry bug. The final composited grid is still
40x80 (36 rows of tree overlaid with 4 rows of base).

## M3 composition note — vertical alignment between the two panels

Observed in proof/M1/panel-t1.00.png: the ASCII tree occupies only the LOWER
portion of its 80x40 grid. cbonsai plants the trunk at row 35 and the canopy
tops out around row 19, so rows 0-18 are permanently blank. That is faithful to
cbonsai and must NOT be "fixed" by cropping or re-centering the grid — the 40-row
geometry is load-bearing (N2) and the fidelity diff depends on it.

Instead, the BLENDER panel must be framed so its tree sits at the SAME apparent
height and scale as the ASCII tree: matching ground line, matching canopy top.
If one tree floats high and the other sits low, the side-by-side reads as two
unrelated widgets — which is exactly the failure N5/M3 is trying to avoid.

Concretely, at t=1: align the Blender pot's rim to the same viewport Y as the
ASCII pot's rim, and size the render so both canopies reach a similar height.
Verify by overlaying or measuring both panels in a real browser screenshot, not
by eye alone.

---

## N7 — The hour must stay alive (secondary maturation)

Found at the M2 look gate, measured: the right branch reached full length by
t=0.067 and its pad was fully open by t=0.18, after which that region changed by
**0.19-0.39 luma per 110 frames through t=0.82**. Whole-frame change between
t=0.55 and t=0.64 was **1.17/255** — visually a still image. The right third of
the picture did nothing for roughly 55 of the 60 minutes.

This is a structural trap, not a one-off bug, and it comes from an honest place:
**cbonsai's growth is inherently front-loaded and discrete.** Branches snap into
existence and never change again. On a terminal running a few seconds that is
invisible. Stretched over an hour it is fatal — and the ASCII panel cannot fix
it, because its timing is the skeleton and the skeleton is the sync contract.

**Therefore the Blender panel must carry the continuity the ASCII panel cannot.**
It has secondary channels the character grid does not have, and they must stay
active for the whole hour rather than switching off at birth:
- **Leaf size**: two-stage — unfurl to ~55% at birth, then ease to 100% by t~0.85
- **Leaf count**: visible cards ramp (~4 -> 8) between birth and t~0.85
- **Leaf colour**: young pads spring yellow-green, settling to deep green by t~0.8
- **Girth**: THICKEN_GAMMA >= 1.4 so wood thickens in the SECOND half
  (gamma 0.60 delivered 83% of final girth by t=0.5 — backwards)

**Hard constraint:** none of this may alter skeleton reach, chain birth steps, or
blossom timing. Those are the sync contract with the ASCII panel (N2/N5) and are
frozen. Secondary maturation rides on top of the skeleton; it never rewrites it.

**Acceptance test — apply this to any growth change:** pick any two consecutive
preview frames in t in [0.55, 0.87]; whole-frame mean|delta| must be >= 0.8/255.
"Monotonic" is necessary but NOT sufficient. A still image is perfectly monotonic.

## Render budget decision — 900x1200 at ~60 minutes is ACCEPTED

The M2 look gate measured the rig's real cost at ~7.2s on heavy frames, giving
**55-65 minutes** for 600 frames, not the ~49 minutes estimated from the earlier
bare-scene probe. The probe scene was far simpler than the finished rig, so the
newer number is the honest one.

**Decision: accept ~60 minutes and keep 900x1200.** Do NOT silently drop to
720x960 to hit a deadline. This is a ONE-TIME build cost for an artifact meant to
be watched for an hour, and N5's frame count stays at 600 regardless. If the
render must be shortened, say so explicitly rather than quietly downscaling —
a silently reduced render is a gate failure (see the M2 criteria).

---

## N8 — Backgrounding the tab must recover gracefully (found at the M3 gate)

Observed: when the tab is hidden the browser suspends requestAnimationFrame, but
GrowthClock keeps tracking real time (correctly — the piece is a function of
wall-clock time). On return the plate briefly reports "stalled" and jumps ahead,
recovering in ~500 ms.

The jump itself is CORRECT and must not be "fixed" by pausing the clock: coming
back after 20 minutes should show 20 minutes of growth, not resume where you
left. What needs fixing is the recovery, not the semantics.

**"Keep the tab visible" is not an acceptable answer.** A piece designed to run
for an hour will be backgrounded — that is the normal case, not the edge case.

Required in M4:
- On `visibilitychange` -> visible, immediately recompute t, re-seat the prefetch
  window around the new playhead, and hold the last good frame until the correct
  one has decoded. Never show a blank, a "stalled" state, or a stale frame that
  visibly snaps.
- The ASCII panel must likewise re-render straight to the correct step rather
  than animating through the skipped steps.
- Verify explicitly: hide the tab for >= 60 s during the soak, restore it, and
  confirm both panels land on the correct t with no blank frame and no visible
  snap. This is a REQUIRED soak step, not an optional one.
