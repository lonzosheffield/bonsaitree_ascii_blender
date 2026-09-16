# M2 look gate — round 2 remediation

Every note in the round-1 verdict, what changed, and the measurement that shows it.
Nothing in this round touches skeleton reach, chain birth steps, `BLOSSOM_*`,
`THICKEN_GAMMA`, the maturation constants, the camera targets, or any light.

## What to look at

| Artifact | What it is |
|---|---|
| `frame_*.png` + `contact-sheet.jpg` | the 12-frame preview spread, 450x600 |
| `regate-900x1200/frame_*.png` | the same 12 frames **plus f130 and f290**, at full 900x1200 |
| `regate-900x1200/crops/` | 3x crops of the apex at f109 and the left branch at f272 |
| `verify-girth-monotonic.txt` | the girth audit: monotonicity, ratio table, gauge in px |
| `round2-art-direction-{before,after}.txt` | the round-1 look verifier, run on both builds |
| `superseded-wire-build/` | the rejected build's frames, kept for comparison |

## Note 1 — structural branches were wire-thin

Constants moved, all of them t-independent base radii:

| constant | was | now |
|---|---|---|
| `DEPTH_TAPER` | 0.71 | **0.80** |
| `TYPE_GIRTH` shootLeft / shootRight | 0.84 | **0.92** |
| `R_MIN` | 0.00085 | **0.0022** |
| `R_FLOOR_BY_DEPTH` | (did not exist) | **(0.0044, 0.0034, 0.0030, 0.0027, 0.0024)** |

The depth-aware floor exists because a flat floor is the wrong shape for this
problem. With one value, every point at recursion depth 3, 4 and 5 sat on
*exactly* the same radius at t=0.18 — a set of identical-gauge bars, which is
the wire reading the gate rejected. Chains are grouped by recursion depth, so
the floor is a constant along any one tube and `max(non-decreasing, constant)`
is still non-decreasing.

**The branch Fable measured — the right pad's primary, chain 2:**

| | rejected | now |
|---|---|---|
| branch radius at t=1 | 3.0 mm | **7.83 mm** |
| vs the 27.8 mm nebari | 0.11 | **0.281** |
| vs the trunk at that height | — | **0.578** |

The trunk is unchanged at 27.837 mm (depth 0 is not tapered), so this is the
branch coming up to meet it, not the trunk coming down.

**First-order branches at their junctions, t=1: 0 of 9 under the 0.25 floor.**
Full table in `verify-girth-monotonic.txt`; the range is 0.529 to 1.451.

**Thinnest leaf-bearing twig at t=1: 2.200 mm** (gate: >= 1.6 mm).

**Monotonicity: worst shrink over 300 sampled frames = 0.000e+00 m.** The 4-pass
radius smoothing is unchanged and still runs once, on the base radii.

## Note 2 — newborn branches were bare, hard-kinked filaments

**(a) Born as a twig, not a hair.** `TIP_TAPER` 0.18 -> **0.45**, `AGE_STEPS`
45 -> **25**. New wood still arrives thinner than it ends up and still fattens
on its own age clock (25 skeleton steps, ~2.6 minutes of model time), so the
channel Fable liked is intact — it just starts from something that reads as
wood. Age is still a smootherstep of a clamped ramp in `steps`, so the contract
holds.

**Thinnest bare wood, per preview frame, in pixels at 900x1200** (gate: >= 5.0):

```
f54  8.00   f109 8.53   f130 8.66   f163 9.04   f218 9.65   f272 7.64
f290 10.58  f327 7.64   f381 11.20  f436 11.20  f490 13.77  f545 14.78
f599 15.83                                   worst on the ladder: 7.64 px
```

Measured back off the render rather than off the model, the apex band at f109
is a median of 8-9 px of silhouette. It was 2 px.

**(b) The staircase.** `CURVE_TENSION` 0.34 -> **0.45**, plus a corner cut in
the new `Skeleton._smooth_nodes`.

The cut runs over the tree's **shared node graph**, not chain by chain, and that
distinction is the whole reason the apex improved at all. A chain's two
endpoints have to stay pinned — one is welded to its parent, the other is the
cell cbonsai put a leaf pad on — and the rejected apex is made of three chains
only one or two cells long, so nearly every point in it *is* an endpoint. There
was nothing in the middle to smooth, and the right angles forming the rectangle
were angles *between* chains, which a per-chain pass never sees. On the node
graph a junction is one node that parent and children all reference, so moving
it once rounds the corner and keeps the weld by construction.

**Path deviation from the literal cbonsai cell: 0.420 cell worst case**, capped
by `NODE_MOVE_MAX_CELLS` (budget: ~0.45).

**(c) Growing tips carry buds.** A leaf's `birthStep` is *exactly* its carrying
segment's — verified, the difference is 0 for all 378 sites — so cards already
started opening the instant their twig existed. What made a tip look bare was
smootherstep's zero slope at 0: at the point where the segment has reached ~60%
extension a card was at 0.9% of its size. So the unfurl is now split — a fast
`bud` term brings each card to `LEAF_BUD_SIZE` (0.38) inside `LEAF_BUD_P` (0.18)
of the window, and the original smootherstep carries the rest. **No birth step
moved and the pad still reaches full size at exactly `LEAF_STEPS`.**

## Non-blocking polish — the backdrop/floor seam

The hard step is gone. The cause was geometry, not shading: the floor plane
stops just in front of the backdrop card, and the card behind it was still
emitting. `build_backdrop` now casts the ray from the lens through the floor's
far edge, carries it back to the card's plane, and drives emission to a true
zero just above where it lands, ramping back over 0.30 m.

Background luma down the frame, gutter columns, f599:

```
 v     before   after
0.50    4.92    4.93     canopy band: untouched
0.55    5.08    4.92
0.60    4.92    3.15
0.70    3.87    0.42
0.75    3.02    0.09
0.79    1.48    0.07     <- the old seam
0.80    0.01    0.10
```

Biggest single-row step in v = 0.70..0.90: **-0.709 luma before, +0.120 after.**

## Nothing else moved

From `round2-art-direction-{before,after}.txt`, identical across the two builds:

- canopy top **v = 0.4533**, pot rim / content bottom **v = 0.9100**
- side margins left 0.1733, right 0.1689
- ambient hue at every sample point, to the decimal
  (backdrop behind canopy RGB 20.3 / 27.2 / 22.6, G-B +4.6, B-R +2.3)
- bottom-row floor luma 0.08
- blossoms absent until f545, full at f599, fallen petals on the soil
- worst N7-window pair **1.064/255** (gate: >= 0.80)
- trunk warmth R-B **+18.7 .. +21.5** across the ladder

`camera.json` is byte-identical to the rejected build's.

The f545/f599 dip in the right-pad leaf-pixel count is blossom occlusion and is
present in the superseded build at the same frames (-10, -150 there; -23, -113
here), so it is not a regression.

## The one thing not fully closed

At f109 the apex still encloses a small closed figure. It is now made of woody
6-9 px tubes with bark, a readable depth hierarchy, rounded junctions and
foliage across it, rather than 2 px of uniform-gauge wire at right angles — but
it is still topologically closed, and it cannot be opened from here. The loop is
cbonsai's own: three short chains that double back on the character grid at
steps 87-101. The ASCII panel draws the same loop. Opening it means changing
skeleton reach, which the brief freezes.

Two ways of bending it away were tried and measured, and both are documented in
the source at `NODE_CUT_PASSES` so nobody re-tries them:

- **More cut passes.** A Laplacian cut moves corners; it cannot bend a straight
  run, and two of that figure's sides are straight runs of cells. Three passes
  changed the rendered apex by almost nothing and raised median node drift to
  0.341 cells. More drift, same picture.
- **A gravity sag on fine wood.** Physically right, and it spent the entire
  deviation budget on a *translation*: sag accumulates down the tree, so by the
  apex all of it had saturated at the cap and the figure moved down 0.42 of a
  row with its shape intact — 51% of all 512 nodes pinned to the cap. Saturating
  also scaled the corner-cut component back down, so the sag was undoing the
  rounding it was meant to help.

Every named cause in the verdict — `R_MIN`, `TIP_TAPER`, `DEPTH_TAPER`,
`CURVE_TENSION` — is addressed and measured. The residual closure is skeleton
topology, and it is the sort of thing that needs a decision rather than another
constant.

## Rig changes, by location

- `blender/bonsai_growth.py`
  - constants: `R_MIN`, `R_FLOOR_BY_DEPTH` + `r_floor()`, `DEPTH_TAPER`,
    `TYPE_GIRTH`, `TIP_TAPER`, `AGE_STEPS`, `CURVE_TENSION`,
    `NODE_CUT_PASSES`, `NODE_MOVE_MAX_CELLS`, `LEAF_BUD_SIZE`, `LEAF_BUD_P`,
    `FLOOR_FAR_Y`, `BACKDROP_FADE_LIFT`, `BACKDROP_FADE_SPAN`
  - `Skeleton._smooth_nodes()` — new; `_build_radii` and `_build_polylines`
    now use `r_floor()` and the smoothed node graph
  - `TreeRig._build_branches` — depth-aware per-frame floor; the root floor
    rides `root_p` so no bead of wood sits on the soil at t=0
  - `TreeRig._build_leaves` — the bud term
  - `build_backdrop(skel, cam_location, floor_z)` — the horizon fade; now built
    after the camera, which reads only the skeleton and the pot
  - CLI: `--frame-list`, so a re-gate can shoot an arbitrary set of frames in
    one `--background` session
- `proof/M2/preview/verify-girth-monotonic.py` — rewritten: ratio table, path
  deviation, and the gauge-in-pixels audit

## Budget note for the orchestrator

Confirmed: 900x1200 / 48 samples runs **6.5-7.7 s/frame** on the heavy frames
here, so a 600-frame ladder is **65-77 minutes**, not the brief's 49. The
12-frame preview at 450x600 costs 36 s; the 14-frame re-gate set at full
900x1200 costs 95 s.
