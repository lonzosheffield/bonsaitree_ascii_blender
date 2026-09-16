# Bonsai Duet

One page, two panels, one clock. On the left, a JavaScript port of
[cbonsai](https://gitlab.com/jallbrit/cbonsai) drawing an ASCII bonsai into an
80×40 character grid. On the right, the *same* tree — grown from the same seeded
branch structure — rendered in Blender as 600 frames of a photographic bonsai.
Both start as a bare pot and both reach full bloom sixty minutes later, at which
point the piece stops rather than looping.

It runs entirely on your own machine, in your own browser, from a static file
server with no dependencies.

---

## Prerequisites

**You need one thing: Node.js 24 or newer.** Get it from
[nodejs.org](https://nodejs.org/) (the LTS installer is fine). Check what you
have with:

```
node --version
```

**There is no install step.** This project has zero npm dependencies — no
`node_modules`, no lockfile, nothing to fetch. `npm install` would do nothing.

**You do not need Blender, Docker, Python, or a C compiler.** Those were
*build-time* tools, used once, by us:

| Tool | What it was for | Do you need it? |
|---|---|---|
| Blender 5.2 | Rendering the 600 frames of the right-hand panel | **No** — the frames are already rendered |
| Docker | Building real `cbonsai` under glibc to verify the RNG port | **No** — verification already happened |
| Python 3 | Render-integrity and contact-sheet tooling | **No** |
| gcc / ncurses | Compiling reference `cbonsai` | **No** |

The right-hand panel is roughly 53 MB of pre-rendered assets under `public/` —
35 MB of JPEG frame ladder plus an 18 MB decorative WebM. They are already
present in this directory. That is why there is nothing to build: the expensive
hour of rendering has already been spent.

> **Note on version control.** This directory is not yet a committed git
> repository — `git init` has been run but nothing is tracked. If you commit it,
> be deliberate about the 53 MB of binary assets under `public/frames/`: commit
> them (the project is self-contained and needs no build), or gitignore them and
> regenerate with `blender/bonsai_growth.py`, which costs ~68 minutes.

---

## Running it

From the project root:

```
npm start
```

Then open:

### **http://localhost:8137/**

That is the whole procedure.

### Why 8137 and not 8080

Port 8080 is permanently occupied on the machine this was built on, by an
unrelated long-running process. Rather than fight over it, the canonical port
moved to 8137, which is out of the way of the usual dev-server crowd (3000,
5173, 8000, 8080). Nothing about the piece depends on the number — set `PORT` to
override it (see [Troubleshooting](#troubleshooting)).

---

## URL parameters

Three parameters control the clock. They can be combined in any order.

| Parameter | Default | What it does |
|---|---|---|
| `?duration=` | `3600` | Length of the run in **model seconds**. This is the tree's own lifetime — the thing the growth curve is a function of. |
| `?speed=` | `1` | Wall-clock multiplier. `speed=60` plays an hour of model time in a minute of real time. |
| `?seed=` | `42` | Integer seed for the ASCII tree's branch structure. |

Growth is a pure function of normalised time `t ∈ [0,1]`, so `duration` and
`speed` are genuinely interchangeable ways of getting to the same picture:
`?duration=3600&speed=60` and `?duration=60` both finish in one real minute and
both show every stage.

### See the whole hour in 60 seconds

Copy-paste this before committing to the real thing:

```
http://localhost:8137/?duration=3600&speed=60
```

It runs the full sixty-minute growth curve, compressed into one real minute —
every phase, the blossoms, and the final hold. Slower samplings are useful too:
`?duration=3600&speed=12` gives you five minutes, which is enough to see the
crossfade behave like motion rather than a slideshow.

### A note on `?seed=`

`?seed=` regrows the **ASCII** tree. The rendered panel is a fixed ladder of
JPEGs baked from seed 42, so at any other seed the two panels stop being the
same tree and the duet becomes a coincidence. Seeds 42 and 1337 have exported
skeletons in `public/`; only 42 has frames. Use other seeds to poke at the
cbonsai port, not to watch the piece.

---

## What to expect

The run moves through five named phases. At the default one-hour duration:

| Phase | Clock | What is happening |
|---|---|---|
| **seed** | 0:00 – 4:48 | A bare pot. Nothing above the soil on either side. |
| **sapling** | 4:48 – 16:48 | The trunk pushes up. First shoots. |
| **branching** | 16:48 – 37:12 | Shoots divide, the canopy takes its shape. |
| **mature** | 37:12 – 52:00 | The silhouette stops changing. The tree thickens, leaves darken from spring yellow-green to deep green, more leaf cards unfurl. |
| **BLOOM** | 52:00 – 60:00 | Blossoms ease in, staggered so nothing pops. |

**Blossoms appear in the final eight minutes.** That is deliberate and it is the
whole shape of the hour: everything before it is the tree earning the flowers.

**At t = 1 the piece stops.** It does not loop, fade out, or reset. Both panels
hold at full bloom, the progress bar reads 100%, and the run tag changes to
`bloomed · held`. If you leave the tab open overnight you will find the same
bloomed tree in the morning.

The middle third is intentionally slow. The ASCII panel's growth is discrete —
a character appears and never changes again — so the rendered panel carries the
continuity: wood thickens on an accelerating curve through the second half,
leaves keep maturing, and the two nearest frames are always crossfaded so the
motion is continuous rather than a six-second slideshow.

Keyboard: press **G** at any time to overlay the alignment guides used to prove
the two canopies sit at the same height. `?guides=1` turns them on at load.

---

## How it works

The interesting part is that both panels are the *same tree*, not two trees that
resemble each other.

**1. One RNG, and it is the right one.** cbonsai calls glibc's `srand()`/`rand()`,
which is not a generic PRNG — it is the TYPE_3 additive-feedback generator,
`r[i] = (r[i-3] + r[i-31]) mod 2^32`, output `r[i] >> 1`, seeded by a Lehmer
sequence and warmed up by discarding 310 outputs. `src/shared/glibc-rand.js` is a
line-for-line port, verified byte-exact against real glibc. A Mersenne Twister
would give a perfectly nice tree — just not *this* tree.

**2. One growth walk.** `src/ascii/bonsai.js` is a translation of cbonsai's
recursive `branch()`/`setDeltas()` model, including the order in which it draws
random numbers (the order is part of the algorithm) and the 80×36 window
geometry it recurses against (branch length is a function of window size). Its
output diffs clean against the real binary's `-p` output for five seeds.

**3. The skeleton is the contract.** `tools/export-skeleton.mjs` runs that frozen
walk and *observes* it — it does not re-derive anything — writing every branch
segment, its parent, its endpoints, and the step at which it was born to
`public/skeleton-42.json`. That file is the shared source of truth.

**4. Blender reads the skeleton.** `blender/bonsai_growth.py` maps each segment
to a tube in 3D: grid x → world X, grid y → world Z, and segment id → world Y,
which is the depth dimension ASCII does not have. No branch position is invented.
Geometry is a pure function of `t`, with no keyframes anywhere in the file —
frame *i* rebuilds the tree from scratch at `t = i / 599`.

**5. The browser scrubs, it does not play.** Video seeking snaps to the nearest
keyframe, which would desynchronise the two panels for reasons having nothing to
do with growth. So the right panel swaps `<img>` frames from a 600-frame JPEG
ladder and crossfades the two nearest, exact by construction. A sliding prefetch
window sized from the clock's speed keeps memory flat across a full hour.

Both panels subscribe to one `GrowthClock`. Neither one drives the other.

### Frozen files

These passed their verification gates and must not be edited — the whole
correspondence between the panels rests on them:

```
src/shared/glibc-rand.js      src/ascii/terminal.js
src/shared/clock.js           tools/export-skeleton.mjs
src/ascii/bonsai.js           blender/bonsai_growth.py
public/skeleton-*.json        public/frames/**
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full pipeline and
[`docs/BRIEF.md`](docs/BRIEF.md) for the constraints that produced it.

---

## Troubleshooting

### `port 8137 is already in use`

Something else has the port. Run it somewhere else:

```powershell
# PowerShell
$env:PORT=8138; npm start
```

```bash
# bash / zsh
PORT=8138 npm start
```

Then open `http://localhost:8138/`. The server prints the URL it actually bound,
so use the one in its own output rather than the one in this README.

To find the culprit first: `Get-NetTCPConnection -LocalPort 8137 -State Listen`
on Windows, `lsof -i :8137` elsewhere.

### `Node 24 or newer is required`

Your `node --version` is too old. Install the current LTS from
[nodejs.org](https://nodejs.org/) and retry. The server checks this on startup
rather than failing later in a confusing way.

### The right-hand panel is blank and the server warned about missing assets

`public/frames/` is missing or incomplete. It should contain 600 files named
`frame-0000.jpg` through `frame-0599.jpg` plus `manifest.json`. Verify with:

```
node tools/verify-frames.mjs
```

If they are genuinely gone, regenerate them with `blender/bonsai_growth.py`
(requires Blender 5.2; takes ~68 minutes).

### I switched tabs and came back

This is expected and handled. The clock tracks **wall-clock time**, not frames,
so backgrounding the tab for twenty minutes and returning shows you twenty
minutes of growth — not a paused tree waiting politely. Browsers suspend
animation callbacks in hidden tabs, so on return both panels recompute `t`, jump
straight to the correct step, and hold the last good frame until the correct one
has decoded. There is no blank frame and no visible snap.

You do not need to keep the tab visible. A piece meant to run for an hour will
be backgrounded; that is the normal case.

### It looks like nothing is happening

Between roughly minutes 20 and 50, change is slow by design — that is what an
hour of growth looks like. Confirm the clock is alive by watching `t+MM:SS` in
the bottom-right, or open the 60-second preview URL above to see the same run
compressed.

### Everything froze at 100%

That is the ending. See [What to expect](#what-to-expect).

---

## Development

```
npm test          # 73 tests: RNG vs. glibc, cbonsai fidelity, clock, renderer
```

No dependencies, no build, no watch step. Edit a file and reload — the server
sends `Cache-Control: no-store` on everything, so there is no stale-module
tarpit.

Rebuilding the rendered panel is a one-time ~60-minute Blender job and is *not*
part of running the piece; see `docs/ARCHITECTURE.md`.
