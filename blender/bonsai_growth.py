#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bonsai_growth.py — the procedural Blender bonsai for the right-hand panel.

    blender --background --factory-startup --python blender/bonsai_growth.py -- \
        --skeleton public/skeleton-42.json --out public/frames --frames 600

    (Run this from PowerShell, NOT Git Bash — Git Bash returns "Permission
    denied" on blender.exe.  See docs/BRIEF.md, "Measured Blender facts".)

================================================================================
THE ONE RULE: GEOMETRY IS A PURE FUNCTION OF NORMALIZED t.
================================================================================

BRIEF N6 — "Growth must be a pure function of normalized t in [0,1], never of
wall-clock or frame count directly."  This script honours that literally:

  * There is not one keyframe, driver, F-curve or animated property in the file.
    `build_tree(t)` tears the branch/leaf/blossom datablocks down and rebuilds
    them from scratch for every frame.  Frame *i* renders `t = i / (frames - 1)`
    and nothing else about frame *i* is an input.  Render frames 300..305 alone
    and you get pixel-identical output to those frames inside a 600-frame run.

  * Nothing consults `random`.  Every "random" quantity — a segment's depth in
    Y, a leaf card's tilt, a blossom's stagger — is `hash32()` of an integer id.
    Same skeleton, same pixels, on any machine, in any order.

  * Growth is MONOTONIC by construction, not by inspection.  Every quantity that
    varies with t is the product of factors that are themselves non-decreasing
    in t (`smootherstep` of a clamped ramp, `thicken(t)`, ...).  A product of
    non-negative non-decreasing factors is non-decreasing.  Geometry can only
    grow; it can never shrink or vanish.  (M2 gates on this.)

    HOW TO MEASURE THAT, because the obvious way misreports.  Measuring the
    silhouette as "pixels differing from frame 0 by more than N" is monotonic
    at N=2 and N=5 and shows small dips at N>=10.  The dips are not geometry.
    They are pixels deep INSIDE the canopy whose value drifts by one or two
    levels — (17,36,5) to (17,35,4) — as new leaves grow in front of old ones
    and shade them.  Those pixels are still covered by the tree; they have just
    fallen back across an arbitrary threshold.  Verified at 128 render samples,
    so it is not sampling noise either.  Use a low threshold, or measure
    coverage from an alpha pass, not a colour delta.

  * The camera is built ONCE, before the render loop, from the skeleton's own
    t=1 bounds, and is never touched again.  Any camera drift would destroy the
    side-by-side sync illusion the whole piece depends on.

================================================================================
WHY THE 3D TREE IS THE SAME TREE AS THE ASCII TREE
================================================================================

Every tube in this render is a segment of `public/skeleton-<seed>.json`, which
`tools/export-skeleton.mjs` observed being grown by the frozen, M1-gated cbonsai
port.  No branch position is invented here.  The mapping is:

    grid x        ->  world X   (scaled by COL_W)
    grid y        ->  world Z   (up; scaled by ROW_H, ground row -> Z = 0)
    segment id    ->  world Y   (depth — the dimension ASCII does not have)

The Y depth is the only thing 3D adds, and it is derived deterministically from
segment ids by `hash32`, accumulated along each branch with a restoring term so
the canopy has real volume without wandering out of the depth of field.

Grid rows are taller than they are wide in a terminal cell, so COL_W < ROW_H;
`COL_ASPECT` carries that ratio.  It is deliberately a touch narrower than a
literal terminal cell (see the constant) because the render is PORTRAIT 900x1200
and a literal mapping would leave the canopy pinned to the frame edges.  This
changes nothing the M3 sync gate measures: that gate is about the pot rim's
viewport Y and the canopy top's viewport Y, both of which are vertical.

================================================================================
THE GROWTH TIMELINE
================================================================================

MEASURED COST on this machine (Intel Xe, Blender 5.2.1, EEVEE, one sequential
`--background` session as the brief requires): at the default 900x1200 / 48
samples, the heaviest frames — full canopy, every blossom open — run ~7.2 s,
and the first frame of a session adds ~3 s of shader compilation. A full
600-frame ladder is therefore roughly 55-65 minutes, not the ~49 minutes the
brief budgeted at 960x960; the extra is the taller frame plus depth of field.
48 samples is visually indistinguishable from 64 here and 25% cheaper, which
is why it is the default. If the number has to come down further, drop
`--res` (N5 fixes the frame count at 600; resolution is the tradeable one).

    t = 0.00              seed — bare pot, nothing above the soil
    t -> STRUCT_END       branches extend, in the skeleton's own birth order
    t = STRUCT_END (0.90) the tree is structurally complete
    t > BLOSSOM_START     blossoms ease in, staggered so petals do not pop
      (0.87)
    t = 1.00              full bloom, thickest wood, a few fallen petals

Wood keeps thickening all the way to t=1 (`thicken()`), so the mature tree reads
as woody rather than wiry even though its silhouette stopped changing at 0.90.

================================================================================
THE SKELETON IS NOT ENOUGH — SECONDARY MATURATION (BRIEF N7)
================================================================================

cbonsai's growth is front-loaded and DISCRETE.  A branch snaps into existence,
its pad opens over LEAF_STEPS = 14 skeleton steps — about 1.6% of the runtime —
and then, as far as the skeleton is concerned, that part of the tree is finished
forever.  On a terminal running for four seconds nobody notices.  Stretched over
an hour it is fatal: the first look gate measured the right-hand pad changing by
0.19-0.39 luma per 110 frames from t=0.18 to t=0.82.  A still image, and a
perfectly monotonic one, which is why "monotonic" is necessary and not
sufficient.

The ASCII panel cannot fix this — its timing IS the sync contract, and a '&' has
no second act.  So this panel carries the continuity for both, using channels
the character grid does not have.  Every leaf SITE runs a maturation clock from
its own birth to MATURE_END, and over that clock its cards grow from
LEAF_UNFURL_FLOOR to full size, more cards unfurl inside the pad (~4 -> 8, gated
on a per-card hash), and the foliage darkens from a spring flush to deep green.
Wood thickens on an ACCELERATING curve (THICKEN_GAMMA), so girth is something
the second half of the hour does rather than something the first half finished.

None of it touches skeleton reach, chain birth steps or blossom timing.  Those
are frozen.  Secondary maturation rides on top of the skeleton; it never
rewrites it — and since every factor is non-negative and non-decreasing in t,
the monotonicity proof above still holds verbatim.

================================================================================
THE WOOD HAS A HIERARCHY (round 2 of the look gate)
================================================================================

The first version of this rig drew everything that was not one of the two main
trunks as a filament.  Measured at t=1: the primary branch feeding the right pad
was 3.0 mm of radius against a 27.8 mm trunk, a ratio of 0.11, and the thinnest
wood in the frame was two pixels wide at the shipped 900x1200 framing.  The tree
read as a fat trunk with bent wire pushed into it, and because new wood was born
at 18% of that already-tiny radius, a newborn branch spent six or seven minutes
of the hour on screen as a bare hair before its pad opened.

Four things fix it and all of them are t-INDEPENDENT base geometry, so the
monotonicity proof above is untouched: a softer per-depth taper (DEPTH_TAPER),
structural shoots weighted as structure rather than as twigs (TYPE_GIRTH), a
girth floor that knows its own recursion depth (R_FLOOR_BY_DEPTH, so the floor
does not flatten the hierarchy everywhere it bites), and wood that is BORN as a
twig rather than a hair (TIP_TAPER) and finishes fattening sooner (AGE_STEPS).
Read those constants for the measured before/after.

Shape, separately: cbonsai walks a character grid, so its branches are runs of
90-degree corners, and `_smooth_nodes` cuts those corners once, at load, over
the tree's shared node graph — which is the only place a corner BETWEEN two
branches exists to be cut.  Every node's drift from its literal cbonsai cell is
capped, and proof/M2/preview/verify-girth-monotonic.py measures it.

================================================================================
THIS FRAME IS HALF OF A DUET
================================================================================

The camera is not framed as a portrait.  It is SOLVED so the pot rim lands at
TARGET_POT_RIM_V and the canopy top at TARGET_CANOPY_TOP_V, which are where the
ASCII tree's pot rim and canopy top land in its own 80x40 panel.  Two landmarks,
two targets, one scale — see `build_camera`.  The floor's pool of light is then
sized from that camera, so it is black before the last row of pixels rather than
running off the bottom edge at luma 35 into the page's near-black plate.
"""

import argparse
import json
import math
import os
import sys
import time

import bpy
from mathutils import Vector

# =============================================================================
# TUNABLES
# =============================================================================
# Everything below is in METRES.  The scale is chosen so the finished tree is a
# credible ~0.37 m bonsai in a ~0.29 m pot: that matters because depth of field
# is a physical effect, and a tree built 100 m tall would refuse to go soft in
# the background no matter what f-stop you asked for.

ROW_H = 0.022                 # world height of one terminal row
COL_ASPECT = 0.42             # world width of one column, as a fraction of ROW_H
COL_W = ROW_H * COL_ASPECT

# --- timeline ---------------------------------------------------------------
STRUCT_END = 0.90             # branches + leaves finish growing here
EXTEND_STEPS = 3.5            # skeleton steps a segment takes to reach full length
LEAF_STEPS = 14.0             # skeleton steps a leaf cluster takes to open
BLOSSOM_START = 0.87          # blossoms may not exist before this
BLOSSOM_SPAN = 0.42           # each blossom's own opening window (normalised)
BLOSSOM_STAGGER = 0.58        # max normalised delay before a blossom starts
PETAL_FALL_START = 0.945      # fallen petals on the soil

# --- wood -------------------------------------------------------------------
R_TRUNK = 0.0133              # radius of the trunk at the nebari
R_MIN = 0.0022                # thinnest twig ANYWHERE (radius, metres)
DEPTH_TAPER = 0.80            # radius multiplier per level of recursion
TYPE_GIRTH = {                # cbonsai branch types have different weights
    "trunk": 1.00,
    "shootLeft": 0.92,
    "shootRight": 0.92,
    "dying": 0.60,
    "dead": 0.47,
}
#
# WHY THESE THREE NUMBERS MOVED (the M2 look gate, round 2).
#
# Measured on the rejected build: at t=1 the primary branch feeding the right
# pad was 3.0 mm of radius against a 27.8 mm trunk — a ratio of 0.11.  Every
# chain that is not one of the two main trunks came out at the same hair-like
# gauge, so the mature tree read as a fat trunk with bent wire pushed into it
# rather than as a tree with a branch hierarchy.  Three constants made it:
#
#   DEPTH_TAPER 0.71  compounds: by recursion depth 4 a branch was down to
#       0.71**4 = 0.25 of the trunk before type and life taper even applied.
#       0.80 puts depth 4 at 0.41 — still an obvious hierarchy, four clearly
#       distinguishable gauges, but wood at every level instead of wire.
#   TYPE_GIRTH shoot* 0.84 -> 0.92  the shoots ARE the branch hierarchy; they
#       are structural wood, not the fine twigs.  `dying` (0.60) and `dead`
#       (0.47) are the twigs and they are deliberately left alone, because the
#       contrast between structural branch and leaf-bearing twig is the thing
#       that reads as a tree.
#   R_MIN 0.00085 -> 0.0022  0.85 mm of radius is 1.7 mm of tube: at the
#       shipped 900x1200 framing (0.70685 m of frame across 900 px, i.e.
#       0.785 mm/px) that is TWO PIXELS.  Two pixels is a hair, whatever the
#       taper above it says.  0.0022 m of radius is 4.4 mm of tube = 5.6 px,
#       clear of the 5 px floor the re-gate asks for.
#
# All three are t-INDEPENDENT base radii.  The per-frame radius is still
# `base * thicken(t) * taper(tip distance) * mature(age)` and every one of
# those factors is unchanged and still non-decreasing in t, so the M2
# monotonicity proof is untouched — see verify-girth-monotonic.py.

# A floor that knows how deep in the hierarchy it is.  A flat R_MIN is the
# wrong shape for this problem: the value that stops a depth-4 twig being a
# hair is far too thin to stop a newborn FIRST-ORDER branch being one, and a
# first-order branch spends minutes on screen bare before its pad opens (that
# is the f109 apex and the f272 coat-hanger).  Chains are grouped by recursion
# depth — `_build_chains` only extends a chain with a same-depth child — so
# every point on a chain shares one depth and this floor is a CONSTANT along
# any given tube.  max(non-decreasing, constant) is non-decreasing, so applying
# it per frame cannot break monotonicity.
#
# It is GRADED all the way down, not a single value that everything deep piles
# onto.  Measured with a flat floor: at t=0.18 every point at recursion depth 3,
# 4 and 5 sat on exactly 2.10 mm, so the apex was a set of bars of identical
# gauge meeting at right angles — a wire frame, which is precisely what the look
# gate rejected.  A floor that steps down with depth keeps a readable hierarchy
# (8.7 / 6.9 / 5.9 / 5.3 px at that frame) even where the floor is what is
# holding the wood up.
R_FLOOR_BY_DEPTH = (0.0044, 0.0034, 0.0030, 0.0027, 0.0024)


def r_floor(depth):
    """Minimum tube radius for a branch at this recursion depth, in metres."""
    if 0 <= depth < len(R_FLOOR_BY_DEPTH):
        return R_FLOOR_BY_DEPTH[depth]
    return R_MIN
# --- nebari: the root flare where the trunk enters the soil ------------------
#
# WHAT WENT WRONG (M2 look gate, round 3).  The flare used to be a PER-SEGMENT
# radius bump, `r *= 1 + NEBARI_FLARE * exp(-rows_up / NEBARI_ROWS)`, applied to
# every depth-0 segment; the trunk spline then simply STARTED at the ground row
# carrying that fat radius.  Blender caps a bevelled curve at its first point,
# so the base of the tree was a flat elliptical face ~4.8 cm across, tilted with
# the trunk's own tangent, catching the rim light — a sawn-off log stuck in a
# tray, with the trunk apparently leaving the collar's SIDE.  It sat at the one
# point in the frame M3 aligns to the ASCII pot rim, so it was the most-looked-at
# ten square centimetres of the hour.
#
# The replacement is the same idea made CONTINUOUS and BURIED:
#   * the flare is a function of world height above the SOIL, applied to the
#     sampled polyline rather than to discrete segments, so there is no step and
#     therefore no bead;
#   * the trunk polyline is EXTENDED DOWNWARD past the soil surface on a curve
#     that leaves the trunk's own tangent smoothly, so the end cap ends up ~3 cm
#     inside the soil mound and what meets the eye at the soil line is bark;
#   * surface roots now radiate out of that flare (TreeRig._precompute_roots).
#
# Two exponential terms.  The broad one is what the old bump did — it gives the
# lower trunk its swell.  The tight one only exists in the last couple of
# centimetres and is the thing that actually reads as nebari.  Both are
# t-INDEPENDENT multipliers on a base radius, exactly like the bump they
# replace, so every factor in `r_base * girth * taper * mature` is unchanged in
# t and the monotonicity proof stands — see verify-girth-monotonic.py.
NEBARI_BROAD_K = 0.50         # extra radius share far from the soil
NEBARI_BROAD_H = 0.060        # metres of decay for the broad swell
NEBARI_TIGHT_K = 0.46         # extra radius share right at the soil line
NEBARI_TIGHT_H = 0.013        # metres of decay for the tight root flare
NEBARI_BURY = 0.030           # metres the trunk continues BELOW its own origin
#
# 0.030 is not a guess.  The trunk's origin sits 13.7 mm ABOVE the soil surface
# (cbonsai plants it on the ground row, the pot rim is one row lower), so a
# 30 mm stub puts the cap face 16.3 mm UNDER the soil — inside the 1-2 cm the
# re-gate asks for, with the mound's own 12.5 mm of relief on top of it.
# verify-nebari-geometry.py prints the measured depth.
NEBARI_BURY_STEPS = 5         # polyline samples spent on the buried section
NEBARI_BURY_TUCK = 0.52       # how far the buried stub narrows toward a taproot
NEBARI_Q_SPAN = 0.90          # curve-parameter span the buried stub occupies
NEBARI_TANGENT_MIX = 0.50     # how much of the trunk's own tangent the stub keeps
THICKEN_FLOOR = 0.50          # girth multiplier at t=0
THICKEN_GAMMA = 1.50          # girth multiplier is THICKEN_FLOOR + rest * t**gamma
#
# THICKEN_GAMMA was 0.60, which is a DECELERATING curve: it delivered
# thicken(0.5) = 0.50 + 0.50*0.5**0.6 = 0.83, i.e. 83% of the final girth in the
# first half of the hour and 17% in the second.  That is backwards for a tree
# whose silhouette also finishes early: both channels emptied themselves before
# half time and the last 30 minutes had nothing left to show.  gamma 1.50
# ACCELERATES — thicken(0.5) = 0.50 + 0.50*0.354 = 0.68, so the second half
# carries 0.32 of the range against the first half's 0.18, nearly 2:1 the other
# way.  Still a pure power of clamped t, so still monotonic by construction.
TIP_TAPER = 0.45              # radius factor of a just-born tip
TIP_LEN = 1.3                 # how many cells behind the tip the taper runs
AGE_STEPS = 25.0              # skeleton steps for new wood to reach full girth
#
# AGE_STEPS gives each SEGMENT its own age clock: new wood is born at TIP_TAPER
# of its final girth and fattens from there.  `steps` is non-decreasing in t and
# birthStep is fixed, so age — and therefore radius — is still non-decreasing.
# The growth contract is untouched.
#
# BOTH NUMBERS MOVED AT THE ROUND-2 LOOK GATE.  0.18 and 45 were tuned against
# the OLD, far thinner base radii, and together they meant a shoot was born at
# 18% of a radius that was already the thinnest thing in the frame and then took
# ~45 steps (8% of t, five minutes of model time) to stop being a hair.  Two
# specific frames showed what that costs: at t=0.18 the apex chain is a bare
# wire tracing a near-closed rectangle above the trunk, and at t=0.45 the left
# primary branch arrives as a naked zigzag coat-hanger.  Each is on screen for
# six or seven minutes of the hour.
#
# 0.45 and 25 mean a shoot is BORN AS A TWIG — 45% of its final radius, already
# past the 5 px floor once R_FLOOR_BY_DEPTH is applied — and still visibly
# doubles in girth over its own age clock (25 steps, ~4.4% of t, ~2.6 minutes),
# so the "new wood arrives thin and fattens" idea survives; it just starts from
# something that reads as wood instead of from wire.  The age ramp is still a
# smootherstep of a clamped ramp in `steps`, so the proof is unchanged.
CURVE_SUBDIV = 4              # spline samples per one-cell step
CURVE_TENSION = 0.45          # 0.5 = Catmull-Rom; lower = less overshoot
NODE_CUT_PASSES = 1           # corner-cut passes over the shared node graph
NODE_MOVE_MAX_CELLS = 0.42    # hard cap on how far the cut may move any node
#
# ONE PASS, and the loop is left open as a knob because two things were tried
# here and measured, and both are worth not re-trying:
#
#   MORE PASSES.  A Laplacian cut moves CORNERS.  It cannot shorten or bend a
#   straight run of cells, and half of the apex the look gate rejected is
#   straight runs — cbonsai's grid is axis-aligned, so that figure has two
#   horizontal sides and two vertical ones.  Iterating to three passes changed
#   the rendered apex by almost nothing while raising the median node drift from
#   the literal cbonsai cell (0.34 cells vs less at one pass).  More drift, same
#   picture: not a trade worth making.
#
#   A GRAVITY SAG.  Physically the right idea — a fine twig cantilevered off a
#   branch droops and a trunk does not — and it spent the ENTIRE deviation
#   budget on a translation.  Sag accumulates down the tree, so by the apex every
#   node had saturated at the cap and the whole figure moved down 0.42 of a row
#   with its shape perfectly intact: 51% of all 512 nodes pinned to the cap.
#   Worse, saturating scaled the corner-cut component back down, so the sag was
#   actively undoing the rounding it was there to help.  A two-cell bar cannot be
#   visibly bent by a deflection that has to stay under half a cell.

# --- 3D depth (the dimension ASCII does not have) ---------------------------
DEPTH_YAW = 0.90              # per-branch consistent sweep in Y
DEPTH_WOB = 0.55              # per-segment wobble in Y
DEPTH_RESTORE = 0.28          # pull back toward Y=0; bounds the depth envelope
TRUNK_YAW_DAMP = 0.35         # keep the trunk near the centre plane

# --- foliage ----------------------------------------------------------------
LEAF_CARDS = 8                # cards per skeleton leaf position
LEAF_LEN = 0.0172             # long axis of one leaf card (~1.7 cm, bonsai scale)
LEAF_WID = 0.0084             # short axis
LEAF_CLUSTER_R = 0.0180       # scatter radius around a skeleton leaf position
LEAF_SIDES = 8                # outline vertices per leaf
LEAF_CUP = 0.16               # centre lift, as a fraction of leaf length

# --- secondary maturation (BRIEF N7) ----------------------------------------
# The skeleton is the sync contract and is frozen: a pad still OPENS in
# LEAF_STEPS = 14 skeleton steps, roughly 1.6% of the hour, and the branch it
# sits on still reaches full length when cbonsai says so.  What was missing is
# everything that happens to a pad AFTER it opens.  A real bonsai pad spends the
# rest of the season getting denser, bigger and darker, and the ASCII panel
# physically cannot show that — a '&' is a '&'.  So the Blender panel carries it.
#
# Three channels, all functions of t alone, all non-decreasing:
#   size   LEAF_UNFURL_FLOOR -> 1.0     (a pad opens small, then fills out)
#   count  LEAF_CARDS_AT_BIRTH -> LEAF_CARDS  (cards gated on a per-card hash)
#   colour spring yellow-green -> deep green   (per-card age, in the shader)
#
# Each runs on the SITE's own clock: a pad born at t=0.62 is as young at t=0.62
# as the first pad was at t=0.05, and they all arrive together at MATURE_END.
LEAF_CARDS_AT_BIRTH = 4       # cards visible the moment a pad opens
LEAF_UNFURL_FLOOR = 0.55      # card size at birth, as a share of its final size
MATURE_END = 0.85             # t at which secondary maturation is complete
MATURE_MIN_SPAN = 0.12        # floor on (MATURE_END - t_birth) for late pads
MATURE_LINEAR = 0.30          # share of the maturation ramp that is plain linear
#
# MATURE_LINEAR exists because smootherstep has ZERO slope at both ends, and a
# maturation curve that flattens out is how the first version of this fix ran
# out of steam: the right pad gained 225 leaf pixels between t=0.73 and t=0.85
# but only 19 of them in the last quarter of that, which is a hair away from
# being another still image.  Blending 30% of a straight line back in keeps a
# real slope all the way to MATURE_END while the smootherstep keeps the ONSET
# soft, which is the end that actually needed easing.  Both terms are
# non-decreasing, so the blend is too.
LEAF_BUD_SIZE = 0.38          # share of a card's size that opens as a BUD
LEAF_BUD_P = 0.18             # share of LEAF_STEPS the bud takes to appear
#
# WHY A BUD PHASE (round-2 look gate, the lower-priority half of note 2).
#
# A leaf's birthStep is EXACTLY its carrying segment's birthStep — verified on
# the shipped skeleton, the difference is 0 for all 378 leaf sites — so cards
# already start opening the instant their twig exists.  The reason a tip still
# looked bare for minutes is smootherstep: it has zero slope at 0, so at 15% of
# the way through LEAF_STEPS (the point where the carrying segment has reached
# ~60% extension) a card was at smootherstep(0.15) = 0.9% of its size.  Invisible.
#
# So rather than moving any birth step — the sync contract forbids that — the
# unfurl is split in two.  A fast `bud` term brings each card to LEAF_BUD_SIZE
# within LEAF_BUD_P of the window, and the original smootherstep carries the
# remaining (1 - LEAF_BUD_SIZE) over the full window.  A tip therefore carries
# visible buds while it is still extending, and the pad still reaches full size
# at exactly LEAF_STEPS, the same skeleton step it always did.  Both terms are
# smooth ramps of the same clamped, non-decreasing p, so the sum is
# non-decreasing and the geometry still cannot shrink.
LEAF_GATE_MAX = 0.76          # the last gated card starts opening at this age
LEAF_GATE_SPAN = 0.22         # age units a gated card takes to unfurl
LEAF_AGE_SPAN = 0.60          # age units for a card to reach its deep green
LEAF_AGE_ATTR = "leafage"     # per-vertex float the leaf shader reads

BLOSSOM_FRACTION = 0.62       # share of leaf positions that also carry blossoms
BLOSSOM_R = 0.0078            # flower radius
BLOSSOM_SIDES = 30            # 5 lobes need a few vertices to stay round
BLOSSOM_PER_SITE = 2
BLOSSOM_CUP = 0.26            # petals curl up toward the centre

FALLEN_PETALS = 34

# --- roots ------------------------------------------------------------------
SURFACE_ROOTS = 5

# --- pot (echoes the 31-column ':___________./~~~\\.___________:' base art) --
POT_COLS = 31.0               # BASE_ART[1].width — cbonsai.c:214
POT_RIM_ROW = 36.0            # first base-art row, i.e. one row below ground
POT_BODY_ROWS = 2.6
POT_FOOT_ROWS = 0.55
POT_BED_DROP = 0.0042         # metres from the rim down to the soil bed
SOIL_PEAK = 0.0125            # height of the soil mound above that bed
#
# POT_BED_DROP and SOIL_PEAK used to be literals inside build_pot/build_soil.
# They are named here because the TRUNK now has to know where the soil surface
# is: it buries its own base under it.  A soil line that two pieces of code
# disagree about would put the cap back on show, so there is exactly one.


def soil_top_z(ground_row):
    """World z of the soil surface directly under the trunk (x=y=0).

    Mirrors build_pot -> build_soil: rim, down to the bed, up to the peak of the
    mound.  A free function rather than a method so the skeleton can bury its
    trunk without being handed the pot it is planted in.
    """
    return (ground_row - POT_RIM_ROW) * ROW_H - POT_BED_DROP + SOIL_PEAK


def soil_z_at(pot, x, y):
    """World z of the soil surface at (x, y) — the same mound build_soil makes."""
    hx = pot["hx"] - pot["lip"] - 0.002
    hy = pot["hy"] - pot["lip"] - 0.002
    fr = min(math.hypot(x / hx, y / hy), 1.0)
    return pot["z_bed"] + SOIL_PEAK * (1.0 - fr * fr)

# --- camera / framing -------------------------------------------------------
LENS_MM = 85.0                # a portrait lens; gentle perspective, nice fall-off
SENSOR_MM = 24.0              # vertical fit
CAM_YAW_DEG = 4.0             # a hint of three-quarter view, not a hero turntable
CAM_ELEV_DEG = 4.0

# THIS FRAME IS NOT A PORTRAIT.  It is the right-hand half of a duet, and the
# left half is a fixed 80x40 character grid it has to agree with.  Measured in
# proof/M1/panel-t1.00.png: cbonsai plants the trunk at row 35 and tops out
# around row 19, so the ASCII tree spans v ~ 0.455 .. 0.905 of its panel — 45%
# of the panel height, with 19 blank rows of headroom above it.  A Blender frame
# composed as a standalone portrait filled 60% of its height instead, so
# scaling the two to a common pot rim in the browser pushed the bottom of this
# render off the plate and cropped the pot feet.
#
# So the framing is SOLVED, not padded.  Two targets fix the frame completely:
# where the pot rim lands and where the canopy top lands, both as a fraction
# down from the top of the frame.  FRAME_MARGIN and SIDE_MARGIN_MIN are then
# only guards on the horizontal, which the vertical solve does not constrain.
TARGET_POT_RIM_V = 0.90       # ASCII pot rim sits at v ~ 0.905
TARGET_CANOPY_TOP_V = 0.45    # ASCII canopy top sits at v ~ 0.455
FRAME_MARGIN = 1.18           # minimum horizontal padding around t=1 content
SIDE_MARGIN_MIN = 0.12        # t=1 content must stay inside x = 0.12 .. 0.88
FOOT_CLEARANCE = 0.002        # metres of floor guaranteed below the pot feet

# --- the backdrop/floor horizon --------------------------------------------
FLOOR_FAR_Y = 1.10            # where the floor plane stops, just in front of
#                               the backdrop card at y = 1.15
BACKDROP_FADE_LIFT = 0.018    # metres of card above the floor's far edge at
#                               which the glow is already at a true zero
BACKDROP_FADE_SPAN = 0.30     # metres over which it climbs back to full

# =============================================================================
# DETERMINISTIC HASH  (BRIEF: "Do not use Python's random module")
# =============================================================================


def hash32(x, salt=0):
    """A 32-bit integer avalanche (splitmix-flavoured). Pure, portable, stable.

    This is NOT a PRNG in the N1 sense and is not used for anything cbonsai
    decided — the tree's shape arrived fully formed in the skeleton JSON.  It
    only decorates: which way a branch leans in depth, how a leaf card is
    tilted, which blossom opens first.  Those need to be arbitrary-looking and
    perfectly reproducible, which is exactly what a hash is for.
    """
    x = (int(x) * 0x9E3779B1 + int(salt) * 0x85EBCA6B + 0x165667B1) & 0xFFFFFFFF
    x ^= x >> 16
    x = (x * 0x85EBCA6B) & 0xFFFFFFFF
    x ^= x >> 13
    x = (x * 0xC2B2AE35) & 0xFFFFFFFF
    x ^= x >> 16
    return x


def rnd01(x, salt=0):
    """Deterministic float in [0, 1)."""
    return hash32(x, salt) / 4294967296.0


def rnd11(x, salt=0):
    """Deterministic float in [-1, 1)."""
    return rnd01(x, salt) * 2.0 - 1.0


# =============================================================================
# EASING
# =============================================================================


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def smoothstep(v):
    v = clamp(v, 0.0, 1.0)
    return v * v * (3.0 - 2.0 * v)


def smootherstep(v):
    """Ken Perlin's 6t^5-15t^4+10t^3. Zero 1st AND 2nd derivative at both ends.

    This is why blossoms do not pop: the second derivative vanishing at v=0
    means a petal's scale leaves zero with zero acceleration, so the eye never
    catches an onset frame.
    """
    v = clamp(v, 0.0, 1.0)
    return v * v * v * (v * (v * 6.0 - 15.0) + 10.0)


# =============================================================================
# SKELETON
# =============================================================================


class Skeleton(object):
    """The cbonsai walk, preprocessed into everything the rig needs per frame.

    All of this is t-independent, so it happens exactly once.  The per-frame
    work is then pure arithmetic over these tables.
    """

    def __init__(self, path):
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)

        self.path = path
        self.seed = data.get("seed")
        self.total_steps = float(data["totalSteps"])
        meta = data.get("meta", {})
        self.root_x = float(meta.get("rootX", data.get("cols", 80) / 2.0))
        self.ground_row = float(meta.get("groundRow", data.get("rows", 36) - 1))

        self.segments = data["segments"]
        self.leaves = data["leaves"]
        self.by_id = {s["id"]: s for s in self.segments}

        self._build_chains()
        self._build_depth()
        self._smooth_nodes()
        self._build_radii()
        self._build_polylines()
        self._build_leaf_sites()
        self._build_bounds()

    # -- chains ---------------------------------------------------------------
    def _build_chains(self):
        """Group the 512 one-cell segments into the ~180 branches that made them.

        cbonsai's `branch()` is recursive; each call walks a run of cells at one
        recursion depth and spawns children at depth+1.  So a segment continues
        its parent's branch exactly when it shares the parent's depth.  The
        export guarantees at most one same-depth child per segment (verified),
        which makes every chain a simple path — no ambiguity, no heuristics.
        """
        self.chain_of = {}
        self.chains = []           # list of lists of segment dicts, in order
        chain_index = {}
        for seg in self.segments:
            parent = seg["parent"]
            if parent < 0 or self.by_id[parent]["depth"] != seg["depth"]:
                idx = len(self.chains)
                self.chains.append([seg])
                chain_index[seg["id"]] = idx
            else:
                idx = self.chain_of[parent]
                self.chains[idx].append(seg)
            self.chain_of[seg["id"]] = idx

        # Life at the head of each chain normalises the taper along it.
        self.chain_life0 = [max(c[0]["life"], 1) for c in self.chains]
        # A per-chain sweep direction in depth. The trunk is damped so it does
        # not lean out of the centre plane and desynchronise from the ASCII.
        self.chain_yaw = []
        for idx, chain in enumerate(self.chains):
            head = chain[0]
            yaw = rnd11(head["id"], 0x51)
            if head["depth"] == 0:
                yaw *= TRUNK_YAW_DAMP
            self.chain_yaw.append(yaw)

    # -- depth ----------------------------------------------------------------
    def _build_depth(self):
        """Give every segment endpoint a Y, so the tree has volume.

        Each step moves in depth by an amount proportional to the step's own
        planar length, in the direction its branch leans, plus a wobble, minus a
        restoring pull toward Y=0.  The restoring term is what keeps the whole
        canopy inside the depth of field: the envelope settles near
        planar_step * (yaw + wob) / DEPTH_RESTORE instead of random-walking away.

        A pleasing accident: 67 of the 512 segments are zero-length in the grid
        (cbonsai wrote a character without moving).  Flat, they are invisible.
        Here they are given a full step of PURE depth movement, so the places
        where the ASCII tree stalls are exactly where the 3D tree turns toward
        or away from the viewer.
        """
        self.seg_y0 = {}   # Y at the segment's start
        self.seg_y1 = {}   # Y at the segment's end
        for seg in self.segments:
            parent = seg["parent"]
            y_start = 0.0 if parent < 0 else self.seg_y1[parent]

            dx = (seg["x1"] - seg["x0"]) * COL_W
            dz = -(seg["y1"] - seg["y0"]) * ROW_H
            planar = math.hypot(dx, dz)
            if planar < 1e-9:
                planar = ROW_H          # a stall in the grid is a step in depth

            yaw = self.chain_yaw[self.chain_of[seg["id"]]]
            wob = rnd11(seg["id"], 0xA7)
            dy = planar * (DEPTH_YAW * yaw + DEPTH_WOB * wob) - DEPTH_RESTORE * y_start

            self.seg_y0[seg["id"]] = y_start
            self.seg_y1[seg["id"]] = y_start + dy

    # -- corner cut -----------------------------------------------------------
    def _smooth_nodes(self):
        """One corner-cut pass over the SHARED node graph, not over each chain.

        Why the graph and not the chain.  cbonsai walks a character grid, so
        every branch is a run of 90-degree corners, and the round-2 look gate
        rejected the result twice over: hard kinks on every non-trunk branch,
        and an apex that drew a near-closed rectangle of wire above the trunk.
        Cutting corners chain-by-chain cannot fix that.  A chain's two ENDPOINTS
        have to stay pinned — the first is welded to its parent branch, the last
        is the cell cbonsai put a leaf pad on — and the apex rectangle is made
        of three chains only one or two cells long, so almost every point in it
        IS an endpoint.  There was nothing left in the middle to smooth, and the
        right angles that formed the rectangle were angles BETWEEN chains, which
        a per-chain pass never sees.

        So the cut happens once, here, on the tree's own node graph.  Every
        control point anywhere in this rig is some segment's END point, and a
        junction is one node that a parent and its children all reference.  Move
        that node once and every branch touching it moves with it: the weld
        holds by construction, no branch can float off its parent, and a corner
        between two chains rounds exactly like a corner inside one.

        It runs NODE_CUT_PASSES times.  See that constant for what iterating it
        does and does not buy, and for the gravity sag that was tried here and
        taken back out.

        WHAT STAYS PUT.  The seedling's base at the soil never moves; it is the
        tree's origin.  Nodes with no continuation — the tips, where the leaf
        pads are — never move either, so a pad still sits on the cell cbonsai
        chose for it.  The M3 sync gate measures the pot rim's viewport V and
        the canopy top's: the pot is not touched here at all, and the canopy top
        is a tip, so it cannot move.

        Every node's TOTAL displacement from its literal cbonsai cell, across
        all passes, is capped at NODE_MOVE_MAX_CELLS.  The cap is also what
        stops cbonsai's own spikes from running away: it does not only turn
        corners, it can jump two columns in a step and then reverse, and an
        uncapped cut on a spike like that moved a point 1.52 cells.  An ordinary
        right-angle corner (0.354 cells) is left untouched.

        This is geometry built ONCE, at load, at full extent.  It is not a
        function of t and it cannot affect monotonicity.
        """
        def world_end(seg):
            return Vector((
                (seg["x1"] - self.root_x) * COL_W,
                self.seg_y1[seg["id"]],
                (self.ground_row - seg["y1"]) * ROW_H,
            ))

        head0 = self.segments[0]
        self.root_pos = Vector((
            (head0["x0"] - self.root_x) * COL_W,
            self.seg_y0[head0["id"]],
            (self.ground_row - head0["y0"]) * ROW_H,
        ))
        raw = {seg["id"]: world_end(seg) for seg in self.segments}

        # The continuation of a node: the child that carries the branch on.
        # Prefer the same-depth child (that is the chain continuing); failing
        # that, the shallowest child, which is the dominant shoot.  A node with
        # no child at all is a tip and does not move.
        children = {}
        for seg in self.segments:
            if seg["parent"] >= 0:
                children.setdefault(seg["parent"], []).append(seg)
        cont = {}
        for sid, kids in children.items():
            same = [k for k in kids if k["depth"] == self.by_id[sid]["depth"]]
            cont[sid] = (same[0] if same
                         else min(kids, key=lambda k: (k["depth"], k["id"])))

        # --- the passes ---------------------------------------------------
        pos = dict(raw)
        for _ in range(max(NODE_CUT_PASSES, 0)):
            nxt_pos = {}
            for seg in self.segments:
                sid = seg["id"]
                nxt = cont.get(sid)
                if nxt is None:
                    nxt_pos[sid] = pos[sid]          # a tip; pinned
                    continue
                prev = pos[seg["parent"]] if seg["parent"] >= 0 else self.root_pos
                nxt_pos[sid] = (prev * 0.25 + pos[sid] * 0.50
                                + pos[nxt["id"]] * 0.25)
            pos = nxt_pos

        # --- one budget, applied to the TOTAL displacement ----------------
        self.node_end = {}
        self.worst_cut_cells = 0.0
        for seg in self.segments:
            sid = seg["id"]
            d = pos[sid] - raw[sid]
            cells = math.hypot(d.x / COL_W, d.z / ROW_H)
            if cells > NODE_MOVE_MAX_CELLS:
                d *= NODE_MOVE_MAX_CELLS / cells
                cells = NODE_MOVE_MAX_CELLS
            self.worst_cut_cells = max(self.worst_cut_cells, cells)
            self.node_end[sid] = raw[sid] + d

    # -- radii ----------------------------------------------------------------
    def _build_radii(self):
        """Base (t-independent) tube radius at each segment's END point.

        Three things thin a branch: recursion depth, how much `life` it has left
        (cbonsai counts life down along a branch, so this is the natural taper),
        and its cbonsai type — `dying`/`dead` are the fine twigs that carry the
        leaves.  The trunk's nebari flare is NOT applied here; it is a function
        of height above the soil, not of segment index, and lives in _nebari().
        """
        self.seg_r = {}
        for seg in self.segments:
            chain = self.chain_of[seg["id"]]
            life_frac = clamp(seg["life"] / float(self.chain_life0[chain]), 0.0, 1.0)
            r = R_TRUNK
            r *= DEPTH_TAPER ** seg["depth"]
            r *= TYPE_GIRTH.get(seg["type"], 0.6)
            r *= 0.22 + 0.78 * (life_frac ** 0.7)
            # NO NEBARI FLARE HERE any more.  A per-segment bump put a step
            # change of radius at the trunk's very first control point, and the
            # curve's own end cap then displayed that step as a flat lit disc at
            # the soil line.  The flare is now a continuous function of height
            # above the soil, applied to the SAMPLED polyline in _nebari(), and
            # it is the same t-independent multiplier it always was.
            self.seg_r[seg["id"]] = max(r, r_floor(seg["depth"]))

        # Smooth the radius profile ALONG each branch.
        #
        # Without this the trunk reads as a stack of blobs: cbonsai steps one
        # cell at a time, and a run of zero-length cells puts several tube
        # sections within a couple of millimetres of each other, so any jump in
        # radius becomes a visible bulge rather than a taper.
        #
        # This is done ONCE, here, on the t-independent base radii — not per
        # frame.  Smoothing per frame would let a point's radius dip at the
        # instant the next segment appeared and gave it a thinner neighbour,
        # which is exactly the kind of "geometry shrank" blip the M2 monotonic
        # gate exists to catch.
        for chain in self.chains:
            if len(chain) < 3:
                continue
            radii = [self.seg_r[s["id"]] for s in chain]
            for _ in range(4):
                nxt = list(radii)
                for i in range(1, len(radii) - 1):
                    nxt[i] = 0.25 * radii[i - 1] + 0.5 * radii[i] + 0.25 * radii[i + 1]
                radii = nxt
            for seg, r in zip(chain, radii):
                self.seg_r[seg["id"]] = max(r, r_floor(seg["depth"]))

    # -- polylines ------------------------------------------------------------
    def _build_polylines(self):
        """Turn each chain's staircase of one-cell steps into a flowing curve.

        cbonsai moves on a character grid, so a branch is literally a staircase.
        Rendered as straight tubes that reads as bent wire or a lightning bolt —
        the first look-dev pass made that obvious. A cardinal spline through the
        same points fixes it while passing EXACTLY through every original cell,
        so the 3D branch still lands on the ASCII branch and the leaf positions
        still sit on their twigs.

        Crucially the smooth curve is built ONCE, here, at full extent.  Growth
        later just advances a cut point along this fixed curve — it never
        reshapes it.  Re-smoothing a partial polyline every frame would let
        earlier points shift as later ones arrived, which is a shape CHANGING
        rather than growing, and the M2 monotonic gate would be right to fail it.

        Each sample carries the curve parameter `q`: q = i means "the end of the
        chain's segment i", so the growth code can map a segment's own progress
        straight onto arc position without searching.
        """
        self.chain_poly = []
        for chain in self.chains:
            head = chain[0]
            parent = head["parent"]
            # Both of these come from the SHARED, already corner-cut node graph
            # (see _smooth_nodes), which is what keeps a branch welded to its
            # parent through the cut: the junction is one node, not two copies.
            ctrl = [self.node_end[parent] if parent >= 0 else self.root_pos]
            radii = [self.seg_r[parent] if parent >= 0
                     else self.seg_r[head["id"]] * 1.15]
            for seg in chain:
                ctrl.append(self.node_end[seg["id"]])
                radii.append(self.seg_r[seg["id"]])

            # The corner cut already happened, ONCE, in _smooth_nodes, on the
            # shared node graph.  Repeating it per chain here would double-
            # smooth and pull the path further off the ASCII tree than the
            # deviation budget allows.
            n = len(ctrl) - 1
            samples = []
            for i in range(n):
                p0 = ctrl[max(i - 1, 0)]
                p1 = ctrl[i]
                p2 = ctrl[i + 1]
                p3 = ctrl[min(i + 2, n)]
                for k in range(CURVE_SUBDIV):
                    u = k / float(CURVE_SUBDIV)
                    samples.append((
                        i + u,
                        _cardinal(p0, p1, p2, p3, u),
                        radii[i] + (radii[i + 1] - radii[i]) * u,
                    ))
            samples.append((float(n), ctrl[n], radii[n]))
            if parent < 0:
                samples = self._nebari(samples)
            self.chain_poly.append(samples)

    # -- nebari ---------------------------------------------------------------
    def _nebari(self, samples):
        """Root flare and buried base for the one chain that starts at the soil.

        Two jobs, both t-independent and both done ONCE, here:

        1. FLARE.  Every sample's radius is multiplied by
               1 + K_broad*exp(-h/H_broad) + K_tight*exp(-h/H_tight)
           where h is that sample's height above the soil surface, clamped at 0.
           It is a smooth function of a position on an already-smooth curve, so
           the girth grows INTO the soil instead of stepping up at one control
           point.  Nothing here depends on t, so this is the same kind of
           constant multiplier the per-segment bump was.

        2. BURY.  A short stub is prepended that leaves the trunk's origin along
           the trunk's own tangent and curves round to vertical, ending
           NEBARI_BURY below the origin — about 3 cm under the mound.  The
           curve's end cap is therefore inside opaque soil, and the silhouette
           at the soil line is bark running down into the bed.

        THE TRUNK'S EXIT POINT DOES NOT MOVE.  The stub is appended BEFORE
        sample q=0, which is still exactly `root_pos`, and it leaves with the
        trunk's own tangent, so the ASCII-aligned skeleton is untouched: no node
        moves, and the M3 pot-rim anchor is where it was.  The stub carries
        NEGATIVE curve parameters, which keeps the growth code's `q = i` means
        "end of segment i" mapping intact for every above-ground sample.
        """
        z_soil = soil_top_z(self.ground_row)

        def flare(z):
            h = max(z - z_soil, 0.0)
            return (1.0
                    + NEBARI_BROAD_K * math.exp(-h / NEBARI_BROAD_H)
                    + NEBARI_TIGHT_K * math.exp(-h / NEBARI_TIGHT_H))

        flared = [(q, pos, r * flare(pos.z)) for q, pos, r in samples]

        p0 = samples[0][1]
        r0 = samples[0][2]                       # un-flared radius at the origin
        tan0 = (samples[1][1] - p0)
        tan0 = tan0.normalized() if tan0.length > 1e-9 else Vector((0.0, 0.0, 1.0))

        # A cubic Hermite from the origin down to the taproot end: it leaves p0
        # along -tan0 (so the join at the soil line is smooth, not a mitre — a
        # kink there would just be a different kind of visible seam) and arrives
        # straight down, so the cap face is horizontal and the mound covers it.
        # The departure direction is the trunk's own tangent BENT TOWARD DOWN,
        # not the tangent itself.  Measured on seed 42, the trunk's first two
        # cells run HORIZONTALLY along the ground row (q=0..2 all sit at z=0),
        # so a pure -tan0 tangent would have thrown the stub 4.6 cm sideways
        # before it turned down and the flare would have lurched out from under
        # the tree.  Mixing in a downward term keeps the join soft — no mitre at
        # the soil line — while the stub still plunges straight in.
        down = Vector((0.0, 0.0, -1.0))
        dir0 = (-tan0 * NEBARI_TANGENT_MIX) + down
        dir0 = dir0.normalized() if dir0.length > 1e-9 else down
        p3 = Vector((p0.x, p0.y, p0.z - NEBARI_BURY))
        t0 = dir0 * NEBARI_BURY
        t3 = down * NEBARI_BURY

        stub = []
        for k in range(NEBARI_BURY_STEPS, 0, -1):
            sv = k / float(NEBARI_BURY_STEPS)
            s2, s3 = sv * sv, sv * sv * sv
            pos = (p0 * (2 * s3 - 3 * s2 + 1)
                   + t0 * (s3 - 2 * s2 + sv)
                   + p3 * (-2 * s3 + 3 * s2)
                   + t3 * (s3 - s2))
            # Below the soil the flare has already saturated, so the stub tucks
            # back in toward a taproot.  Without that it would be a 6 cm column
            # of wood under a 2.5 cm mound and would push out through the far
            # side of the soil.
            below = clamp((z_soil - pos.z) / NEBARI_BURY, 0.0, 1.0)
            stub.append((-NEBARI_Q_SPAN * sv, pos,
                         r0 * flare(pos.z) * (1.0 - NEBARI_BURY_TUCK * below)))
        return stub + flared

    # -- leaves ---------------------------------------------------------------
    def _build_leaf_sites(self):
        """Explode each skeleton leaf cell into a cluster of oriented cards.

        One ASCII '&' is one character cell.  In 3D that same cell becomes
        LEAF_CARDS little leaves scattered in a ball around the point, each with
        its own outward-biased normal.  That is what turns a sparse point cloud
        into a canopy with distinct clusters instead of a lollipop — and the
        clusters land where cbonsai put them, at the branch tips.
        """
        # (birthStep, centre, u, v, length, width, t_birth, gate)
        #
        # The last two are the secondary-maturation channel (BRIEF N7).
        # `t_birth` is the normalised time this SITE opens, so every pad runs
        # its own maturation clock from its own birth to MATURE_END rather than
        # sharing one global ramp: a pad born at t=0.62 is as young at 0.62 as
        # the first pad was at 0.05.  `gate` is the per-card age at which this
        # particular card becomes visible — 0 for the LEAF_CARDS_AT_BIRTH cards
        # that open with the pad, and spread out to LEAF_GATE_MAX for the rest,
        # so a pad thickens from ~4 cards to ~8 over its own maturation.
        self.leaf_cards = []
        self.blossom_sites = []   # (birthStep, centre, u, v, stagger)
        span = max(self.total_steps, 1.0)
        for i, leaf in enumerate(self.leaves):
            seg_id = leaf["segmentId"]
            # struct_u() maps t onto skeleton steps, so the inverse of a
            # birthStep is (birthStep / total_steps) * STRUCT_END.
            t_birth = clamp(leaf["birthStep"] / span, 0.0, 1.0) * STRUCT_END
            depth_y = self.seg_y1.get(seg_id, 0.0)
            cx = (leaf["x"] - self.root_x) * COL_W
            cz = (self.ground_row - leaf["y"]) * ROW_H
            centre = Vector((cx, depth_y, cz))

            # Outward direction from the trunk axis: leaves face away from the
            # centre of the tree and slightly up, like real foliage reaching.
            outward = Vector((cx, depth_y, 0.0))
            if outward.length < 1e-6:
                outward = Vector((1.0, 0.0, 0.0))
            outward.normalize()

            for k in range(LEAF_CARDS):
                key = i * 97 + k
                off = Vector((rnd11(key, 0x11), rnd11(key, 0x12), rnd11(key, 0x13)))
                if off.length > 1e-9:
                    off.normalize()
                off *= LEAF_CLUSTER_R * (0.35 + 0.65 * rnd01(key, 0x14))
                # squash the cluster vertically so clusters read as pads
                off.z *= 0.70

                jitter = Vector((rnd11(key, 0x21), rnd11(key, 0x22), rnd11(key, 0x23)))
                normal = (outward * 0.55 + Vector((0.0, 0.0, 0.45)) + jitter * 0.85)
                if normal.length < 1e-6:
                    normal = Vector((0.0, 0.0, 1.0))
                normal.normalize()
                u, v = _basis_from_normal(normal, rnd01(key, 0x24) * math.tau)

                size = 0.72 + 0.56 * rnd01(key, 0x25)
                if k < LEAF_CARDS_AT_BIRTH:
                    gate = 0.0
                else:
                    j = k - LEAF_CARDS_AT_BIRTH
                    late = max(LEAF_CARDS - LEAF_CARDS_AT_BIRTH, 1)
                    gate = LEAF_GATE_MAX * (j + 0.35 + 0.45 * rnd01(key, 0x26)) / late
                self.leaf_cards.append(
                    (leaf["birthStep"], centre + off, u, v,
                     LEAF_LEN * size, LEAF_WID * size, t_birth, gate)
                )

            if rnd01(i, 0x31) < BLOSSOM_FRACTION:
                for k in range(BLOSSOM_PER_SITE):
                    key = i * 131 + k
                    off = Vector((rnd11(key, 0x41), rnd11(key, 0x42), rnd11(key, 0x43)))
                    if off.length > 1e-9:
                        off.normalize()
                    off *= LEAF_CLUSTER_R * (0.45 + 0.75 * rnd01(key, 0x44))
                    normal = (outward * 0.5 + Vector((0.0, 0.0, 0.5))
                              + Vector((rnd11(key, 0x45), rnd11(key, 0x46),
                                        rnd11(key, 0x47))) * 0.8)
                    if normal.length < 1e-6:
                        normal = Vector((0.0, 0.0, 1.0))
                    normal.normalize()
                    u, v = _basis_from_normal(normal, rnd01(key, 0x48) * math.tau)
                    self.blossom_sites.append(
                        (self.leaves[i]["birthStep"], centre + off, u, v,
                         rnd01(key, 0x49) * BLOSSOM_STAGGER)
                    )

    # -- bounds ---------------------------------------------------------------
    def _build_bounds(self):
        """The t=1 extents of everything, used ONCE to frame the fixed camera."""
        xs, zs = [], []
        for seg in self.segments:
            xs.append((seg["x0"] - self.root_x) * COL_W)
            xs.append((seg["x1"] - self.root_x) * COL_W)
            zs.append((self.ground_row - seg["y0"]) * ROW_H)
            zs.append((self.ground_row - seg["y1"]) * ROW_H)
        for card in self.leaf_cards:
            c = card[1]
            xs.append(c.x - LEAF_LEN)
            xs.append(c.x + LEAF_LEN)
            zs.append(c.z - LEAF_LEN)
            zs.append(c.z + LEAF_LEN)

        pot_half = POT_COLS * COL_W * 0.5
        xs.append(-pot_half)
        xs.append(pot_half)
        zs.append(-(POT_RIM_ROW - self.ground_row + POT_BODY_ROWS + POT_FOOT_ROWS) * ROW_H)

        self.min_x, self.max_x = min(xs), max(xs)
        self.min_z, self.max_z = min(zs), max(zs)
        self.canopy_top = self.max_z


def _cardinal(p0, p1, p2, p3, u):
    """Cardinal spline through p1 (u=0) and p2 (u=1), tangents scaled by tension.

    CURVE_TENSION = 0.5 is plain Catmull-Rom, and on cbonsai's hard staircase
    that overshoots at every step: at full resolution the trunk came out as a
    string of regular pebble-like bulges. Slackening the tangents keeps the
    flow but stops the curve bellying out past its own control points.
    """
    u2 = u * u
    u3 = u2 * u
    m1 = (p2 - p0) * CURVE_TENSION
    m2 = (p3 - p1) * CURVE_TENSION
    return (p1 * (2.0 * u3 - 3.0 * u2 + 1.0)
            + m1 * (u3 - 2.0 * u2 + u)
            + p2 * (-2.0 * u3 + 3.0 * u2)
            + m2 * (u3 - u2))


def _basis_from_normal(normal, roll):
    """Two orthonormal vectors spanning the plane perpendicular to `normal`."""
    helper = Vector((0.0, 0.0, 1.0))
    if abs(normal.dot(helper)) > 0.94:
        helper = Vector((1.0, 0.0, 0.0))
    u = normal.cross(helper)
    u.normalize()
    v = normal.cross(u)
    v.normalize()
    ca, sa = math.cos(roll), math.sin(roll)
    return (u * ca + v * sa), (u * -sa + v * ca)


# =============================================================================
# BLENDER HELPERS  (version-tolerant: 5.2 renamed a lot of 4.x properties)
# =============================================================================


def set_if(owner, name, value):
    """Assign only if the property exists on this Blender build. Returns bool.

    EEVEE-Next dropped, renamed and re-added a long list of properties between
    4.x and 5.x.  Guessing wrong raises and kills a 50-minute render on frame 1,
    so every optional knob goes through here.
    """
    if owner is not None and hasattr(owner, name):
        try:
            setattr(owner, name, value)
            return True
        except Exception:
            return False
    return False


def set_socket(node, name, value):
    """Set one input socket by name. Blender 5.x turned many node *properties*
    into sockets (the Glare node lost `glare_type` and gained a 'Type' socket),
    so this is the socket-shaped sibling of `set_if`."""
    try:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return True
    except Exception:
        pass
    return False


def set_input(node, names, value):
    """Set the first socket that exists, by any of several historical names."""
    for name in names:
        try:
            if name in node.inputs:
                node.inputs[name].default_value = value
                return True
        except Exception:
            continue
    return False


def new_mix_rgb(nt, location=(0, 0)):
    """A colour A/B mix, on whichever node this Blender build actually ships.

    Blender 3.4 replaced `ShaderNodeMixRGB` with the multi-type `ShaderNodeMix`
    and kept the old one as a legacy node; which of the two exists, and what its
    sockets are called, has moved more than once.  `ShaderNodeMix`'s sockets are
    genuinely ambiguous BY NAME — it carries a 'Factor' and an 'A' and a 'B' for
    every data type it supports — so the colour ones are addressed by index,
    which is stable.  Returns (node, fac, a, b, result).
    """
    try:
        node = nt.nodes.new("ShaderNodeMixRGB")
        node.location = location
        node.blend_type = "MIX"
        return node, node.inputs[0], node.inputs[1], node.inputs[2], node.outputs[0]
    except Exception:
        pass
    node = nt.nodes.new("ShaderNodeMix")
    node.location = location
    node.data_type = "RGBA"
    node.blend_type = "MIX"
    node.clamp_factor = True
    return node, node.inputs[0], node.inputs[6], node.inputs[7], node.outputs[2]


def new_material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    return mat, nt, out


def ensure_material(obj, mat):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)


def link_object(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def new_mesh_object(name):
    mesh = bpy.data.meshes.new(name + "Mesh")
    obj = bpy.data.objects.new(name, mesh)
    return link_object(obj)


def rebuild_mesh(obj, verts, faces, smooth=False, attr_name=None, attr_values=None):
    """Replace an object's geometry wholesale. This is the per-frame workhorse.

    `attr_name`/`attr_values` write one float per vertex into a POINT-domain
    colour attribute, which is how the leaf shader learns how old each card is.
    A FLOAT_COLOR attribute (value replicated into R, G and B, so the Attribute
    node's `Fac` — the mean of RGB — returns it unchanged) is used rather than a
    bare FLOAT attribute because colour attributes are the path EEVEE has
    supported continuously across 4.x and 5.x.  The whole thing is best-effort:
    if the attribute cannot be created the geometry still renders, it just
    renders at whatever the shader's default is.
    """
    mesh = obj.data
    mats = [m for m in mesh.materials]
    mesh.clear_geometry()
    if verts and faces:
        mesh.from_pydata(verts, [], faces)
        if smooth:
            mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
        if attr_name and attr_values and len(attr_values) == len(verts):
            try:
                layer = mesh.color_attributes.new(
                    name=attr_name, type="FLOAT_COLOR", domain="POINT")
                flat = []
                for a in attr_values:
                    flat.extend((a, a, a, 1.0))
                layer.data.foreach_set("color", flat)
            except Exception as exc:                 # pragma: no cover
                sys.stderr.write(
                    "[bonsai] attribute %r unavailable: %r\n" % (attr_name, exc))
        mesh.update()
    if not mesh.materials:
        for m in mats:
            mesh.materials.append(m)


# =============================================================================
# STATIC SET DRESSING
# =============================================================================


def build_world():
    """Deep near-black with a subtle vertical lift — NOT flat black."""
    world = bpy.data.worlds.new("BonsaiWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputWorld")
    out.location = (400, 0)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.location = (200, 0)
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (0, 0)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-200, 0)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = (-400, 0)

    # Generated, for a world, is the view direction; its Z is "how far up am I
    # looking", remapped to a slow cool gradient.
    map_range = nt.nodes.new("ShaderNodeMapRange")
    map_range.location = (-100, -180)
    map_range.inputs["From Min"].default_value = -0.6
    map_range.inputs["From Max"].default_value = 0.8

    # THE COOL FAMILY IS GREEN-CYAN, NOT BLUE.
    #
    # It was blue: measured on the rejected build the backdrop glow came back
    # RGB(25,35,49), B-R = +24.  On its own that is a perfectly good cold studio.
    # Beside the ASCII panel it is a disaster, because that panel is a green
    # phosphor terminal — #00ff41 text, green glow vignette, near-black plate.
    # Two different colour temperatures side by side read as two unrelated
    # widgets, which is the exact failure the brief's M3 composition note warns
    # about.  So the whole ambient family moves to a desaturated green-cyan that
    # echoes the phosphor: G >= B, and B - R only just positive.
    #
    # The WARM key is untouched.  Warm bark against a cool ambient is the
    # strongest lighting idea in this frame and it survives the hue change
    # intact — in fact it reads better, because a green-cyan ambient is further
    # from 3100 K wood than a blue one was.
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.0032, 0.0044, 0.0038, 1.0)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (0.0225, 0.0320, 0.0250, 1.0)

    nt.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], map_range.inputs["Value"])
    nt.links.new(map_range.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    bg.inputs["Strength"].default_value = 1.0


def build_backdrop(skel, cam_location=None, floor_z=None):
    """A soft pool of light behind the canopy.

    This is the difference between "black background" and "a room the tree is
    standing in".  It is a plane far enough back that depth of field turns it to
    a wash, carrying a spherical gradient centred behind and just above the
    canopy so the silhouette has something to be a silhouette against.

    `cam_location` and `floor_z` are optional and only drive the horizon fade
    described below; without them the card behaves exactly as it used to.
    """
    centre_z = (skel.min_z + skel.max_z) * 0.5 + 0.06
    half_w, half_h = 1.9, 1.5
    depth = 1.15

    # The plane's vertices are LOCAL, and the object is moved to the glow
    # centre.  Building it in world space and leaving the origin at (0,0,0) —
    # the obvious way — puts the gradient's centre 1.15 m in front of the plane,
    # so the whole backdrop sits at a texture distance of ~0.98 and renders as a
    # uniform near-black card that OCCLUDES the world gradient behind it.  That
    # is the "flat black background" the brief explicitly rules out, and it is
    # invisible in a thumbnail: the tree still looks fine, the background just
    # quietly stops doing anything.
    verts = [
        (-half_w, 0.0, -half_h),
        (half_w, 0.0, -half_h),
        (half_w, 0.0, half_h),
        (-half_w, 0.0, half_h),
    ]
    obj = new_mesh_object("Backdrop")
    obj.data.from_pydata(verts, [], [(0, 1, 2, 3)])
    obj.data.update()
    obj.location = (0.0, depth, centre_z)

    mat, nt, out = new_material("BackdropGlow")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.location = (350, 0)
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (120, 0)
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "SPHERICAL"
    grad.location = (-80, 0)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (-280, 0)
    # Y is scaled to zero: the plane has no thickness, so only its own X/Z
    # matter, and leaving Y in would swamp the distance with the plane's stand-
    # off from the tree.
    mapping.inputs["Location"].default_value = (0.0, 0.0, 0.0)
    mapping.inputs["Scale"].default_value = (1.45, 0.0, 1.72)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = (-480, 0)

    # Green-cyan, same family as the world ramp and the floor pool.  The
    # LUMINANCE is deliberately held at where the blue version sat (~0.035
    # linear at the bright stop) — the glow's job is to give the canopy
    # something to be a silhouette against, and that job is about brightness.
    # Only the hue moved.
    elems = ramp.color_ramp.elements
    elems[0].position = 0.0
    elems[0].color = (0.0014, 0.0020, 0.0017, 1.0)
    elems[1].position = 1.0
    elems[1].color = (0.0265, 0.0375, 0.0295, 1.0)
    mid = elems.new(0.50)
    mid.color = (0.0058, 0.0082, 0.0070, 1.0)

    nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])

    # --- the horizon fade: make this read as a cyc, not as a wall -----------
    #
    # Measured at the round-2 look gate: the backdrop card met the floor in a
    # HARD STEP — luma 6 dropping to luma 0 across two rows at v ~ 0.79 — and
    # that step ran straight across the trunk behind the pot.  A horizontal
    # line at a fixed height, with light above it and nothing below, is the
    # single strongest cue for "wall meeting a table", which is the opposite of
    # the infinite-dark room this frame is trying to be.
    #
    # The step is a geometry seam, not a shading one: the floor plane ends at
    # FLOOR_FAR_Y, five centimetres in front of this card, and the card behind
    # it is still emitting.  So find where that edge falls ON THIS CARD — cast
    # the ray from the lens through the floor's far edge and carry it back to
    # the card's plane — and drive the emission to a true zero just above it,
    # ramping back to full over BACKDROP_FADE_SPAN.  Now the glow dies before
    # the floor line reaches it and the two blacks meet as one black.
    #
    # This costs nothing anywhere else in the frame: the glow's centre is up at
    # canopy height, so at the fade band the ramp is already near its dark stop.
    fade = None
    if cam_location is not None and floor_z is not None:
        dy = FLOOR_FAR_Y - cam_location[1]
        if abs(dy) > 1e-9:
            s = (depth - cam_location[1]) / dy
            z_seam = cam_location[2] + (floor_z - cam_location[2]) * s
            z_black = z_seam + BACKDROP_FADE_LIFT
            fade = nt.nodes.new("ShaderNodeMapRange")
            fade.location = (-80, -260)
            set_if(fade, "clamp", True)
            fade.inputs["From Min"].default_value = z_black - centre_z
            fade.inputs["From Max"].default_value = (z_black - centre_z
                                                     + BACKDROP_FADE_SPAN)
            sep = nt.nodes.new("ShaderNodeSeparateXYZ")
            sep.location = (-280, -260)
            nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
            nt.links.new(sep.outputs["Z"], fade.inputs["Value"])

    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    emit.inputs["Strength"].default_value = 1.0
    if fade is not None:
        # Straight into Strength, not through a mix node: the fade is a scalar
        # and Emission Strength is a scalar, so there is nothing to convert and
        # no deprecated MixRGB/Mix spelling to guess at across Blender versions.
        nt.links.new(fade.outputs["Result"], emit.inputs["Strength"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    ensure_material(obj, mat)
    return obj


def build_floor(skel, floor_z, pot, cam_info):
    # --- how big the pool of light is allowed to be -------------------------
    # This used to be two hand-tuned numbers, (3.3, 2.7), and the comment below
    # claimed the pool fell to nothing before the frame edge.  It did not:
    # measured on the rejected build, the bottom four rows averaged RGB(33,35,41)
    # in EVERY frame.  The pool was ~0.37 m deep toward the camera and the frame
    # bottom only reached 0.31 m, so the render simply stopped before the light
    # did.  Now the pool is SIZED FROM THE CAMERA: the semi-axis toward the lens
    # is 80% of the distance to where the bottom edge of the frame lands on the
    # floor, so there is always a genuinely black band of floor under the pot
    # before the last row of pixels, whatever the framing targets are set to.
    y_bottom = abs(cam_info.get("floor_y_at_frame_bottom", 0.0))
    pool_y = clamp(0.80 * y_bottom, pot["hy"] + 0.012, 0.16)
    pool_x = clamp(pool_y * 2.0, pot["hx"] + 0.030, 0.42 * cam_info["frame_w"])

    verts = [(-1.4, -1.0, floor_z), (1.4, -1.0, floor_z),
             (1.4, FLOOR_FAR_Y, floor_z), (-1.4, FLOOR_FAR_Y, floor_z)]
    obj = new_mesh_object("Floor")
    obj.data.from_pydata(verts, [], [(0, 1, 2, 3)])
    obj.data.update()

    mat, nt, out = new_material("FloorSlate")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (300, 0)
    set_input(bsdf, ["Metallic"], 0.0)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.20)

    # A pool of light around the pot, falling to nothing before the frame edge.
    #
    # Earlier passes had a flat dark slate here and it still came back as a
    # bright grey sweep across the bottom corners, because the rim lights spill
    # onto it from behind.  Fading the albedo radially costs one texture and
    # kills the spill exactly where it competes with the tree, while keeping the
    # faint reflection directly under the pot that makes the pot feel placed
    # rather than pasted on.
    fcoord = nt.nodes.new("ShaderNodeTexCoord")
    fcoord.location = (-620, 180)
    fmap = nt.nodes.new("ShaderNodeMapping")
    fmap.location = (-430, 180)
    # Location stays at the origin.  It used to carry (0, 0.10, -floor_z), and
    # the Z term was a quiet bug: the Mapping node scales BEFORE it translates,
    # so scaling Z by 0 and then adding -floor_z put a constant 0.09 offset into
    # a "flat" radial gradient, capping it at Fac = 0.91 and shrinking the pool
    # by a factor that moved whenever the pot did.
    fmap.inputs["Location"].default_value = (0.0, 0.0, 0.0)
    fmap.inputs["Scale"].default_value = (1.0 / pool_x, 1.0 / pool_y, 0.0)
    fgrad = nt.nodes.new("ShaderNodeTexGradient")
    fgrad.gradient_type = "SPHERICAL"
    fgrad.location = (-240, 180)
    framp = nt.nodes.new("ShaderNodeValToRGB")
    framp.location = (-50, 180)
    # Same desaturated green-cyan family as the world and the backdrop card:
    # G >= B, and B - R small.  A blue floor beside a green-phosphor terminal
    # is the thing that made the two panels read as unrelated widgets.
    fe = framp.color_ramp.elements
    fe[0].position = 0.0
    fe[0].color = (0.0000, 0.0000, 0.0000, 1.0)
    fe[1].position = 1.0
    fe[1].color = (0.0040, 0.0054, 0.0044, 1.0)
    fmid = framp.color_ramp.elements.new(0.46)
    fmid.color = (0.0006, 0.0008, 0.0007, 1.0)
    nt.links.new(fcoord.outputs["Object"], fmap.inputs["Vector"])
    nt.links.new(fmap.outputs["Vector"], fgrad.inputs["Vector"])
    nt.links.new(fgrad.outputs["Fac"], framp.inputs["Fac"])
    nt.links.new(framp.outputs["Color"], bsdf.inputs["Base Color"])

    # Roughness rides the same pool. Fading the albedo alone was not enough:
    # what actually lit the bottom corners was the SPECULAR reflection of the
    # big area lights, which does not care about base colour at all. Polished
    # under the pot, near-matte by the frame edge.
    rramp = nt.nodes.new("ShaderNodeValToRGB")
    rramp.location = (-50, -30)
    re = rramp.color_ramp.elements
    re[0].position = 0.0
    re[0].color = (0.96, 0.96, 0.96, 1.0)
    re[1].position = 1.0
    re[1].color = (0.42, 0.42, 0.42, 1.0)
    nt.links.new(fgrad.outputs["Fac"], rramp.inputs["Fac"])
    nt.links.new(rramp.outputs["Color"], bsdf.inputs["Roughness"])

    # And so does specular reflectance. This is the one that actually mattered:
    # with the albedo already at zero the floor still came back mid-grey across
    # the whole bottom of the frame, because a rough specular lobe at F0=0.016
    # returns ~0.04 radiance under 100 W of rim light, and AgX lifts 0.04 to a
    # clearly visible grey. Killing specular outside the pool is what finally
    # put the floor into the dark, while the pot keeps its reflection.
    sramp = nt.nodes.new("ShaderNodeValToRGB")
    sramp.location = (-50, -250)
    #
    # The outer stop is now a true zero and the knee has moved out to 0.55, so
    # specular reflectance is essentially absent everywhere except directly
    # under the pot.  F0 = 0.015 across the whole outer floor was still enough,
    # under 100 W of rim light, for AgX to lift it to a visible grey — which is
    # exactly the band the bottom rows were showing.
    se = sramp.color_ramp.elements
    se[0].position = 0.0
    se[0].color = (0.000, 0.000, 0.000, 1.0)
    se[1].position = 1.0
    se[1].color = (0.420, 0.420, 0.420, 1.0)
    smid = sramp.color_ramp.elements.new(0.55)
    smid.color = (0.020, 0.020, 0.020, 1.0)
    nt.links.new(fgrad.outputs["Fac"], sramp.inputs["Fac"])
    for socket_name in ("Specular IOR Level", "Specular"):
        if socket_name in bsdf.inputs:
            nt.links.new(sramp.outputs["Color"], bsdf.inputs[socket_name])
            break

    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.location = (-100, -200)
    set_input(noise, ["Scale"], 22.0)
    set_input(noise, ["Detail"], 6.0)
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (90, -200)
    set_input(bump, ["Strength"], 0.12)
    set_input(bump, ["Distance"], 0.004)
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    ensure_material(obj, mat)
    return obj


def _rounded_rect_ring(hx, hy, z, corner, per_corner=4):
    """A rectangle ring with rounded corners — a bonsai pot, in plan view."""
    corner = min(corner, hx * 0.9, hy * 0.9)
    pts = []
    centres = [(hx - corner, hy - corner), (-(hx - corner), hy - corner),
               (-(hx - corner), -(hy - corner)), (hx - corner, -(hy - corner))]
    starts = [0.0, math.pi * 0.5, math.pi, math.pi * 1.5]
    for (cx, cy), a0 in zip(centres, starts):
        for i in range(per_corner + 1):
            a = a0 + (math.pi * 0.5) * (i / float(per_corner))
            pts.append((cx + corner * math.cos(a), cy + corner * math.sin(a), z))
    return pts


def _bridge_rings(verts, faces, ring_a, ring_b):
    """Quad strip between two equal-length closed rings already in `verts`."""
    n = len(ring_a)
    for i in range(n):
        j = (i + 1) % n
        faces.append((ring_a[i], ring_a[j], ring_b[j], ring_b[i]))


def _push_ring(verts, pts):
    base = len(verts)
    verts.extend(pts)
    return list(range(base, base + len(pts)))


def build_pot(skel):
    """The wide shallow pot from ':___________./~~~\\.___________:'.

    31 columns wide and 4 rows deep in the ASCII, so 31 columns wide and 4 rows
    deep here — the rim sits one row BELOW the ground row the trunk stands on,
    exactly as the base art sits below the tree window (BRIEF N2 addendum).
    """
    hx = POT_COLS * COL_W * 0.5
    hy = hx * 0.44
    z_rim = (skel.ground_row - POT_RIM_ROW) * ROW_H
    z_bed = z_rim - POT_BED_DROP
    z_bot = z_rim - POT_BODY_ROWS * ROW_H
    z_foot = z_bot - POT_FOOT_ROWS * ROW_H
    lip = 0.0085

    verts, faces = [], []
    r_out_top = _push_ring(verts, _rounded_rect_ring(hx, hy, z_rim, 0.013))
    r_in_top = _push_ring(verts, _rounded_rect_ring(hx - lip, hy - lip, z_bed, 0.010))
    r_out_mid = _push_ring(verts, _rounded_rect_ring(hx * 0.995, hy * 0.995,
                                                     z_rim - 0.010, 0.013))
    r_out_bot = _push_ring(verts, _rounded_rect_ring(hx * 0.795, hy * 0.775,
                                                     z_bot, 0.011))

    _bridge_rings(verts, faces, r_out_top, r_in_top)     # rim, seen from above
    _bridge_rings(verts, faces, r_out_mid, r_out_top)    # outer wall, upper
    _bridge_rings(verts, faces, r_out_bot, r_out_mid)    # outer wall, tapering
    faces.append(tuple(r_in_top))                        # the soil bed
    faces.append(tuple(reversed(r_out_bot)))             # base

    # Two feet, echoing the '(_)                     (_)' row of the base art.
    foot_hx = hx * 0.145
    foot_hy = hy * 0.62
    for sign in (-1.0, 1.0):
        cx = sign * hx * 0.52
        top = _push_ring(verts, _rounded_rect_ring(foot_hx, foot_hy, z_bot + 0.001, 0.006))
        bot = _push_ring(verts, _rounded_rect_ring(foot_hx * 0.9, foot_hy * 0.9,
                                                   z_foot, 0.006))
        for r in (top, bot):
            for i in range(len(r)):
                verts[r[i]] = (verts[r[i]][0] + cx, verts[r[i]][1], verts[r[i]][2])
        _bridge_rings(verts, faces, bot, top)
        faces.append(tuple(reversed(bot)))

    obj = new_mesh_object("Pot")
    obj.data.from_pydata(verts, [], faces)
    obj.data.polygons.foreach_set("use_smooth", [True] * len(obj.data.polygons))
    obj.data.update()

    bev = obj.modifiers.new("Bevel", "BEVEL")
    bev.width = 0.0022
    bev.segments = 2
    set_if(bev, "limit_method", "ANGLE")
    set_if(bev, "angle_limit", math.radians(35.0))

    mat, nt, out = new_material("PotGlaze")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (320, 0)
    set_input(bsdf, ["Base Color"], (0.0150, 0.0172, 0.0215, 1.0))
    set_input(bsdf, ["Roughness"], 0.29)
    set_input(bsdf, ["Metallic"], 0.0)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.70)
    set_input(bsdf, ["Coat Weight", "Clearcoat"], 0.35)
    set_input(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.22)
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.location = (-60, -220)
    set_input(noise, ["Scale"], 70.0)
    set_input(noise, ["Detail"], 5.0)
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (130, -220)
    set_input(bump, ["Strength"], 0.08)
    set_input(bump, ["Distance"], 0.0012)
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    ensure_material(obj, mat)

    return obj, dict(hx=hx, hy=hy, z_rim=z_rim, z_bed=z_bed,
                     z_bot=z_bot, z_foot=z_foot, lip=lip)


def build_soil(pot):
    """A low mossy mound inside the rim — where the trunk actually emerges."""
    hx = pot["hx"] - pot["lip"] - 0.002
    hy = pot["hy"] - pot["lip"] - 0.002
    z0 = pot["z_bed"]
    peak = SOIL_PEAK
    rings, cols = 7, 24

    verts, faces = [], []
    idx = []
    for ri in range(rings + 1):
        fr = ri / float(rings)
        row = []
        for ci in range(cols):
            a = math.tau * ci / cols
            x = hx * fr * math.cos(a)
            y = hy * fr * math.sin(a)
            lumps = (0.55 * math.sin(a * 3.0 + fr * 5.0)
                     + 0.45 * math.sin(a * 7.0 - fr * 3.0))
            z = z0 + peak * (1.0 - fr * fr) + 0.0016 * lumps * (1.0 - fr)
            row.append(len(verts))
            verts.append((x, y, z))
        idx.append(row)
    for ri in range(rings):
        for ci in range(cols):
            cj = (ci + 1) % cols
            faces.append((idx[ri][ci], idx[ri][cj], idx[ri + 1][cj], idx[ri + 1][ci]))

    obj = new_mesh_object("Soil")
    obj.data.from_pydata(verts, [], faces)
    obj.data.polygons.foreach_set("use_smooth", [True] * len(obj.data.polygons))
    obj.data.update()

    mat, nt, out = new_material("Soil")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (340, 0)
    set_input(bsdf, ["Roughness"], 0.94)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.12)
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (120, 0)
    ramp.color_ramp.elements[0].color = (0.0016, 0.0013, 0.0010, 1.0)
    ramp.color_ramp.elements[1].color = (0.0058, 0.0074, 0.0034, 1.0)  # a little moss
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.location = (-90, 0)
    set_input(noise, ["Scale"], 95.0)
    set_input(noise, ["Detail"], 10.0)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (150, -230)
    set_input(bump, ["Strength"], 0.80)
    set_input(bump, ["Distance"], 0.0035)
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    ensure_material(obj, mat)
    return obj


# =============================================================================
# MATERIALS FOR THE GROWING PARTS
# =============================================================================


def make_bark_material():
    mat, nt, out = new_material("Bark")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (400, 0)
    # ROUGHNESS AND SPECULAR (M2 look gate, round 3).  At Roughness 0.76 and
    # Specular 0.32 the 12-sided tubes carried a narrow, bright, COOL specular
    # streak down one edge of every branch — the rim light reflected rather than
    # wrapped — and a hard specular line following a uniform-gauge S-curve is
    # exactly what a bent metal or glazed-clay pipe looks like.  0.86 / 0.14
    # keeps a wide diffuse wrap on the lit edge and kills the streak; the rim is
    # still there, it just is not a mirror any more.
    set_input(bsdf, ["Roughness"], 0.86)
    set_input(bsdf, ["Metallic"], 0.0)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.14)

    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = (-620, 0)
    # Stretch the noise along the tube axis: bark runs in fibres, not in dots.
    # 7.0 / 0.55 is a 12.7:1 anisotropy: a 3 mm feature across the tube is a
    # ~4 cm fibre along it.  It is deliberately not MORE than that.  The
    # coordinates are OBJECT space, so on a branch that runs horizontally a hard
    # Z squash puts the fine variation ACROSS the tube and the branch comes out
    # looking threaded, like a screw; 0.30 (23:1) was tried and rejected for
    # exactly that, and 0.75 (8.7:1, the value the speckle build shipped) had
    # too little direction in it to read as grain at all.
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (-440, 0)
    mapping.inputs["Scale"].default_value = (7.0, 7.0, 0.55)

    # THE SPECKLE (M2 look gate, round 3).  Scale 34 x mapping 6.5 is 221 cycles
    # per metre, i.e. a 4.5 mm base feature — fine but legible.  Detail 9 then
    # stacked nine octaves on top of it, down to 4.5mm/512 = 0.009 mm, which at
    # the shipped 0.785 mm/px is two orders of magnitude below a pixel.  That is
    # not texture, it is per-pixel noise: it aliased into crawling white static
    # at 450x600 and read as speckled clay at panel scale.
    #
    # 46 x 7.0 = 322 cycles/m -> a 3.1 mm feature, inside the 2-4 mm the re-gate
    # asks for and ~4 px wide at 900 px, with Detail 2.0 so the finest octave is
    # still ~0.8 mm and nothing lands under the sampler.
    grain = nt.nodes.new("ShaderNodeTexNoise")
    grain.location = (-250, 0)
    set_input(grain, ["Scale"], 46.0)
    set_input(grain, ["Detail"], 2.0)
    set_input(grain, ["Roughness"], 0.42)

    # A slow mottle so losing the octaves does not leave the bark flat: 8 x 7.0
    # is a ~1.8 cm plate, far too coarse to alias, mixed in at 35% to vary the
    # ridge/crevice balance along the trunk.
    plate = nt.nodes.new("ShaderNodeTexNoise")
    plate.location = (-250, -230)
    set_input(plate, ["Scale"], 8.0)
    set_input(plate, ["Detail"], 1.5)
    set_input(plate, ["Roughness"], 0.40)
    blend, blend_fac, blend_a, blend_b, blend_out = new_mix_rgb(
        nt, location=(-140, -110))
    blend_fac.default_value = 0.35

    # ALBEDO CONTRAST.  The old ramp ran 0.0046 -> 0.0520, an 11:1 ratio, so the
    # high-frequency noise above was ALSO a high-contrast mask: the speckle was
    # bright white dots on near-black. 0.0128 -> 0.0402 is 3.1:1, a spread of
    # 0.027 in albedo (the re-gate allows 0.15) with the same mean, so exposure
    # and the measured trunk warmth are unchanged while the static is gone.
    # R:B stays at ~2.2 on both stops — this is a contrast change, not a hue one.
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (-40, 0)
    e = ramp.color_ramp.elements
    e[0].position = 0.24
    e[0].color = (0.0128, 0.0090, 0.0058, 1.0)   # crevice
    e[1].position = 0.80
    e[1].color = (0.0402, 0.0281, 0.0182, 1.0)   # lit ridge
    nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], grain.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], plate.inputs["Vector"])
    nt.links.new(grain.outputs["Fac"], blend_a)
    nt.links.new(plate.outputs["Fac"], blend_b)
    nt.links.new(blend_out, ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])

    # The bump now rides the SAME blended, low-frequency field.  Driving a bump
    # from a nine-octave noise is how you get a surface that sparkles under a
    # rim light; driving it from a 3 mm fibre gives relief you can actually see,
    # so the distance goes up even though the noise got calmer.
    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (200, -240)
    set_input(bump, ["Strength"], 0.85)
    set_input(bump, ["Distance"], 0.0036)
    nt.links.new(blend_out, bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def make_leaf_material():
    """Leaves must transmit light, or the cool rim light does nothing for them.

    A Principled/Translucent mix is the version-proof way to get that: the back
    of a leaf lit from behind glows, which is the single effect that separates
    the canopy from a near-black background.
    """
    mat, nt, out = new_material("Leaf")
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.location = (420, 0)
    mix.inputs["Fac"].default_value = 0.34

    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (200, 140)
    # Roughness 0.50 / Specular 0.28 was glitter, not foliage.  Measured on the
    # rejected build: cool highlight pixels (luma > 200, B > R) climbed
    # 23 -> 140 -> 286 -> 601 across the run on a 450x600 frame, and at contact
    # sheet scale the canopy read as white frost.  A broad rough leaf under a
    # big soft rim is what a leaf actually is; the TRANSLUCENT half of this mix
    # is what carries the rim light, and it is untouched at 0.34.  The specular
    # lobe was only ever competing with the blossoms, which are the things that
    # are supposed to be the brightest objects in the canopy at t=1.
    set_input(bsdf, ["Roughness"], 0.68)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.14)
    trans = nt.nodes.new("ShaderNodeBsdfTranslucent")
    trans.location = (200, -140)

    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = (-520, 0)
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.location = (-320, 0)
    set_input(noise, ["Scale"], 34.0)     # varies per leaf cluster, not per pixel
    set_input(noise, ["Detail"], 2.0)
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (-110, 0)
    e = ramp.color_ramp.elements
    e[0].position = 0.30
    e[0].color = (0.0068, 0.0235, 0.0078, 1.0)   # deep shadowed green
    e[1].position = 0.80
    e[1].color = (0.0640, 0.1480, 0.0430, 1.0)   # sunlit green
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])

    # --- age: the third continuity channel (BRIEF N7) -----------------------
    # `_build_leaves` writes a per-vertex float, 0 = the card unfurled this
    # instant, 1 = fully hardened off, into the LEAF_AGE_ATTR colour attribute.
    # New growth on a bonsai is famously a different colour from old growth, so
    # a pad born at t=0.62 arrives spring yellow-green and darkens to the same
    # deep green as the rest by t~0.8.  That is a channel the ASCII panel has no
    # way to show, and it keeps the canopy moving long after the skeleton has
    # stopped.  The noise ramp still does all the per-leaf variation; age only
    # slides the whole family toward or away from the young tint.
    age_attr = nt.nodes.new("ShaderNodeAttribute")
    age_attr.location = (-520, -420)
    set_if(age_attr, "attribute_type", "GEOMETRY")
    age_attr.attribute_name = LEAF_AGE_ATTR

    young = nt.nodes.new("ShaderNodeRGB")
    young.location = (-320, -420)
    young.outputs[0].default_value = (0.1180, 0.1720, 0.0300, 1.0)   # spring flush

    _, bm_fac, bm_a, bm_b, bm_out = new_mix_rgb(nt, (60, 60))
    nt.links.new(age_attr.outputs["Fac"], bm_fac)
    nt.links.new(young.outputs[0], bm_a)
    nt.links.new(ramp.outputs["Color"], bm_b)
    nt.links.new(bm_out, bsdf.inputs["Base Color"])

    trans_ramp = nt.nodes.new("ShaderNodeValToRGB")
    trans_ramp.location = (-110, -260)
    te = trans_ramp.color_ramp.elements
    te[0].color = (0.0700, 0.1500, 0.0380, 1.0)
    te[1].color = (0.1900, 0.3100, 0.0700, 1.0)
    nt.links.new(noise.outputs["Fac"], trans_ramp.inputs["Fac"])

    young_trans = nt.nodes.new("ShaderNodeRGB")
    young_trans.location = (-320, -560)
    young_trans.outputs[0].default_value = (0.3000, 0.3900, 0.0900, 1.0)
    _, tm_fac, tm_a, tm_b, tm_out = new_mix_rgb(nt, (60, -260))
    nt.links.new(age_attr.outputs["Fac"], tm_fac)
    nt.links.new(young_trans.outputs[0], tm_a)
    nt.links.new(trans_ramp.outputs["Color"], tm_b)
    nt.links.new(tm_out, trans.inputs["Color"])

    nt.links.new(bsdf.outputs["BSDF"], mix.inputs[1])
    nt.links.new(trans.outputs["BSDF"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    return mat


def make_blossom_material(name="Blossom", emission=0.045):
    mat, nt, out = new_material(name)
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.location = (460, 0)
    mix.inputs["Fac"].default_value = 0.40

    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (240, 150)
    set_input(bsdf, ["Roughness"], 0.55)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.38)
    # A whisper of emission so petals hold a glow against the near-black.
    set_input(bsdf, ["Emission Color"], (0.9600, 0.7400, 0.7900, 1.0))
    set_input(bsdf, ["Emission Strength"], emission)
    trans = nt.nodes.new("ShaderNodeBsdfTranslucent")
    trans.location = (240, -150)
    trans.inputs["Color"].default_value = (0.9700, 0.8200, 0.8600, 1.0)

    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = (-500, 0)
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.location = (-300, 0)
    set_input(noise, ["Scale"], 28.0)
    set_input(noise, ["Detail"], 2.0)
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (-90, 0)
    e = ramp.color_ramp.elements
    e[0].position = 0.32
    e[0].color = (0.8300, 0.5600, 0.6100, 1.0)   # pink-shadowed petal
    e[1].position = 0.78
    e[1].color = (0.9850, 0.9300, 0.9350, 1.0)   # near-white highlight
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])

    nt.links.new(bsdf.outputs["BSDF"], mix.inputs[1])
    nt.links.new(trans.outputs["BSDF"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    return mat


# =============================================================================
# LIGHTING  — warm key, cool rim, shallow fill.
# =============================================================================


def add_area_light(name, location, target, color, energy, size, size_y=None):
    data = bpy.data.lights.new(name, type="AREA")
    data.energy = energy
    data.color = color
    if size_y is not None:
        data.shape = "RECTANGLE"
        data.size = size
        data.size_y = size_y
    else:
        data.shape = "SQUARE"
        data.size = size
    set_if(data, "use_shadow", True)
    set_if(data, "shadow_soft_size", size * 0.5)

    obj = bpy.data.objects.new(name, data)
    obj.location = location
    direction = Vector(target) - Vector(location)
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return link_object(obj)


def build_lights(skel, pot):
    """Warm key, cool rim, almost no fill — the whole scene lives in the dark.

    The energies below are low on purpose.  The first look-dev pass ran a key at
    46 W and the pot, the floor and the bark all came back near-white under AgX:
    a "dark cinematic studio" is not achieved by painting things dark, it is
    achieved by not pouring light on them.  What remains is a narrow warm key
    that models the trunk, and rim lights that are the actual subject.
    """
    canopy = Vector((0.0, 0.0, (skel.min_z + skel.max_z) * 0.54))
    warm = (1.000, 0.760, 0.520)     # ~3100 K  — UNCHANGED, and must stay so
    # The cool side is no longer a blue sky, it is the phosphor the panel next
    # door is made of: a desaturated green-cyan.  Its LUMINANCE is matched to
    # the blue it replaces (0.646 -> 0.857 relative luminance) and the wattages
    # below are divided by that ratio, so the rim contributes the same amount of
    # light it always did.  This is a hue change, not an exposure change.
    #
    # ROUND 3: R RAISED ABOVE B.  (0.550, 0.950, 0.850) is B-biased, so every
    # wood edge the rim touched came back with B > R — a saturated cyan line
    # down the side of every branch, which is most of what made the tubes read
    # as metal.  (0.820, 0.980, 0.760) is still green-dominant, still obviously
    # the phosphor gel, but R >= B, so bark lit by it stays inside the warm
    # R-B >= +8 the verifier measures.  Its relative luminance rises 0.858 ->
    # 0.929, so the wattages below are divided by 1.083 to hold the exposure:
    # 80 -> 74, 40 -> 37.  The BACKDROP glow and the pot-rim cool spec are NOT
    # touched — those are the tie to the phosphor panel and they are untouched
    # on purpose.
    cool = (0.820, 0.980, 0.760)

    # Key: high, tight, and well off to camera-left so most of the trunk stays
    # in shadow and only one side of the bark catches the light.
    #
    # 22 W, not the 8.5 W of the first pass. At 8.5 W against a 108 W rim and a
    # 48 W low rim the warm side of the bark simply was not there: every frame
    # came back neutral grey putty, monochrome cool-blue plus leaf green, and
    # wood that is not warm anywhere does not read as wood. 46 W is still the
    # measured blow-out point for the pot and floor under AgX, so this sits at
    # under half of it. The size also drops 0.34 -> 0.25: a tighter source puts
    # the extra energy on the camera-left face of the trunk instead of spilling
    # it into the floor pool, so the light pool underneath does not grow.
    add_area_light("KeyWarm",
                   (-0.48, -0.34, canopy.z + 0.40),
                   canopy + Vector((0.02, 0.0, -0.04)), warm, 22.0, 0.25)

    # The rim IS the picture. Behind and above, aimed back toward the lens, so
    # every leaf edge and every petal gets a cool outline against the dark.
    #
    # 80 W, down from 108 W.  Two reasons and they compound: the green-cyan gel
    # is 1.33x brighter per watt than the blue it replaces, and the leaf
    # material has given up its specular lobe (Roughness 0.50 -> 0.68, Specular
    # 0.28 -> 0.14) so the rim is no longer being multiplied by a mirror finish
    # on 3000 leaf cards.  80 * 0.857 = 68.6 luminance-watts against the old
    # 108 * 0.646 = 69.8: the rim is the same strength, it just is not glittering
    # any more.
    add_area_light("RimCool",
                   (0.46, 0.72, canopy.z + 0.40),
                   canopy + Vector((-0.02, -0.12, -0.02)), cool, 74.0, 0.34, 0.72)

    # A second, lower rim from the other side keeps the silhouette from reading
    # as one flat edge — this is what makes the canopy look gnarled rather than
    # cut out with scissors.
    add_area_light("RimCoolLow",
                   (-0.64, 0.56, canopy.z - 0.12),
                   canopy, cool, 37.0, 0.30)

    # Barely there. Just enough to keep the shadow side from going to pure zero.
    add_area_light("Fill",
                   (0.88, -0.56, canopy.z - 0.02),
                   canopy, (0.600, 0.800, 0.750), 0.9, 0.85)

    # A small warm kicker that finds the pot glaze and the nebari, so the base
    # of the picture is not a black hole.
    add_area_light("PotKick",
                   (-0.30, -0.36, pot["z_rim"] + 0.13),
                   Vector((-0.02, 0.0, pot["z_rim"])), (1.000, 0.720, 0.470),
                   1.1, 0.20)


# =============================================================================
# CAMERA  — built once, never touched again.
# =============================================================================


def build_camera(skel, pot, res_x, res_y, fstop, use_dof):
    content_min_z = pot["z_foot"] - 0.004
    content_max_z = skel.max_z + LEAF_LEN * 0.5
    content_min_x = min(skel.min_x, -pot["hx"]) - LEAF_LEN * 0.5
    content_max_x = max(skel.max_x, pot["hx"]) + LEAF_LEN * 0.5

    content_w = content_max_x - content_min_x
    content_h = content_max_z - content_min_z
    centre_x = (content_min_x + content_max_x) * 0.5

    aspect = res_y / float(res_x)

    # --- the vertical solve -------------------------------------------------
    # Two landmarks, two targets, one unknown scale.  Subtracting the two
    # definitions of v eliminates frame_top and leaves frame_h outright:
    #
    #   pot_rim_v    = (frame_top - z_rim)   / frame_h = TARGET_POT_RIM_V
    #   canopy_top_v = (frame_top - z_canopy)/ frame_h = TARGET_CANOPY_TOP_V
    #   =>  (z_canopy - z_rim) / frame_h     = TARGET_POT_RIM_V - TARGET_CANOPY_TOP_V
    #
    # so the tree occupies exactly (0.90 - 0.45) = 45% of the frame height, the
    # same share the ASCII tree occupies of its 40-row panel, and it sits at the
    # same height in it.  No eyeballing, no iteration.
    span_v = TARGET_POT_RIM_V - TARGET_CANOPY_TOP_V
    frame_h = (skel.max_z - pot["z_rim"]) / span_v
    frame_w = frame_h / aspect

    # --- the horizontal guard -----------------------------------------------
    # The solve above says nothing about width, so check it and widen only if
    # the t=1 canopy (blossoms included — they are in content_max_x via the leaf
    # cards) would come closer to a side edge than SIDE_MARGIN_MIN.  Widening
    # costs vertical accuracy, so it is deliberately the last resort; at the
    # shipped skeleton it does not trigger.
    need_w = max(content_w / (1.0 - 2.0 * SIDE_MARGIN_MIN),
                 content_w * FRAME_MARGIN)
    if frame_w < need_w:
        frame_w = need_w
        frame_h = frame_w * aspect

    frame_top = pot["z_rim"] + TARGET_POT_RIM_V * frame_h
    frame_bottom = frame_top - frame_h
    # Never crop the pot feet, whatever the targets ask for.
    if frame_bottom > content_min_z - FOOT_CLEARANCE:
        frame_bottom = content_min_z - FOOT_CLEARANCE
        frame_top = frame_bottom + frame_h
    target = Vector((centre_x, 0.0, frame_bottom + frame_h * 0.5))

    half_fov_v = math.atan((SENSOR_MM * 0.5) / LENS_MM)
    dist = (frame_h * 0.5) / math.tan(half_fov_v)

    yaw = math.radians(CAM_YAW_DEG)
    elev = math.radians(CAM_ELEV_DEG)
    offset = Vector((
        math.sin(yaw) * math.cos(elev),
        -math.cos(yaw) * math.cos(elev),
        math.sin(elev),
    )) * dist
    location = target + offset

    data = bpy.data.cameras.new("Camera")
    data.lens = LENS_MM
    data.sensor_fit = "VERTICAL"
    data.sensor_height = SENSOR_MM
    data.sensor_width = SENSOR_MM * (res_x / float(res_y))
    data.clip_start = 0.05
    data.clip_end = 60.0

    if use_dof:
        data.dof.use_dof = True
        # Focus on the front of the canopy, not the frame centre: the near
        # foliage should be crisp and the backdrop should dissolve.
        focus_point = Vector((centre_x, -0.045, skel.max_z * 0.60))
        data.dof.focus_distance = (focus_point - location).length
        data.dof.aperture_fstop = fstop
        set_if(data.dof, "aperture_blades", 7)
        set_if(data.dof, "aperture_rotation", math.radians(11.0))

    obj = bpy.data.objects.new("Camera", data)
    obj.location = location
    obj.rotation_euler = (target - location).to_track_quat("-Z", "Y").to_euler()
    link_object(obj)
    bpy.context.scene.camera = obj

    # Where the BOTTOM EDGE of the frame meets the floor plane.  The floor's
    # pool of light is sized from this so it is guaranteed to have died before
    # the last row of pixels: the page's plate behind this panel is near-black,
    # and a floor that is still luma 35 at the frame edge cuts as a hard grey
    # band across the bottom of the composition.
    quat = (target - location).to_track_quat("-Z", "Y")
    down_edge = (quat @ Vector((0.0, 0.0, -1.0))
                 - (quat @ Vector((0.0, 1.0, 0.0))) * math.tan(half_fov_v))
    floor_y_bottom = 0.0
    if abs(down_edge.z) > 1e-9:
        s = (pot["z_foot"] - location.z) / down_edge.z
        floor_y_bottom = location.y + down_edge.y * s

    info = dict(
        location=tuple(round(v, 6) for v in location),
        rotation_deg=tuple(round(math.degrees(v), 4) for v in obj.rotation_euler),
        lens_mm=LENS_MM,
        frame_w=round(frame_w, 5),
        frame_h=round(frame_h, 5),
        distance=round(dist, 5),
        focus_distance=round(getattr(data.dof, "focus_distance", 0.0), 5),
        ground_z=0.0,
        pot_rim_z=round(pot["z_rim"], 5),
        canopy_top_z=round(skel.max_z, 5),
        frame_bottom_z=round(frame_bottom, 5),
        frame_top_z=round(frame_bottom + frame_h, 5),
        frame_left_x=round(centre_x - frame_w * 0.5, 5),
        frame_right_x=round(centre_x + frame_w * 0.5, 5),
        content_min_x=round(content_min_x, 5),
        content_max_x=round(content_max_x, 5),
        floor_y_at_frame_bottom=round(floor_y_bottom, 5),
    )
    # Side margins, as a fraction of frame width, for the t=1 content bounds.
    info["content_left_u"] = round(
        (content_min_x - (centre_x - frame_w * 0.5)) / frame_w, 5)
    info["content_right_u"] = round(
        (content_max_x - (centre_x - frame_w * 0.5)) / frame_w, 5)
    # The M3 gate needs to line this panel up with the ASCII panel. These two
    # numbers are where the pot rim and the canopy top land in the rendered
    # image, as a fraction from the TOP of the frame — measurable, not eyeballed.
    info["pot_rim_v"] = round(
        (frame_bottom + frame_h - pot["z_rim"]) / frame_h, 5)
    info["canopy_top_v"] = round(
        (frame_bottom + frame_h - skel.max_z) / frame_h, 5)
    info["ground_v"] = round((frame_bottom + frame_h) / frame_h, 5)
    return obj, info


# =============================================================================
# THE GROWING TREE  — rebuilt from scratch, from t, every frame
# =============================================================================


def thicken(t):
    """Girth multiplier. Non-decreasing on [0,1]; keeps going after growth stops.

    The silhouette is finished at STRUCT_END but the wood is not: this is what
    turns a wiry sapling into something that reads as woody by t=1.
    """
    return THICKEN_FLOOR + (1.0 - THICKEN_FLOOR) * (clamp(t, 0.0, 1.0) ** THICKEN_GAMMA)


def struct_u(t):
    """Structural progress: t remapped so all growth completes at STRUCT_END."""
    return clamp(t / STRUCT_END, 0.0, 1.0)


class TreeRig(object):
    """Owns the four datablocks that change with t, and nothing else."""

    def __init__(self, skel, bark_mat, leaf_mat, blossom_mat, petal_mat, pot):
        self.skel = skel
        self.pot = pot

        curve = bpy.data.curves.new("BranchCurve", type="CURVE")
        curve.dimensions = "3D"
        curve.resolution_u = 1
        curve.bevel_depth = 1.0      # point radii are then literal metres
        curve.bevel_resolution = 3   # 12-sided tubes: enough to read as round wood
        curve.use_fill_caps = True
        self.branch_obj = bpy.data.objects.new("Branches", curve)
        link_object(self.branch_obj)
        ensure_material(self.branch_obj, bark_mat)

        self.leaf_obj = new_mesh_object("Leaves")
        ensure_material(self.leaf_obj, leaf_mat)
        self.blossom_obj = new_mesh_object("Blossoms")
        ensure_material(self.blossom_obj, blossom_mat)
        self.petal_obj = new_mesh_object("FallenPetals")
        ensure_material(self.petal_obj, petal_mat)

        self._precompute_roots()

    # -- surface roots --------------------------------------------------------
    def _precompute_roots(self):
        """A few exposed roots spreading over the soil. Pure bonsai vocabulary.

        They are tied to the trunk's own first segment, so they appear with the
        seedling and thicken with everything else — never independently.
        """
        self.roots = []
        # A root starts ON the flare's surface, not on the trunk's axis.  They
        # used to start at x=y=0, which put every one of them inside the collar
        # where nothing could see it; the base therefore had no radiating
        # structure at all and read as a stump rather than as nebari.
        r_collar = R_TRUNK * (1.0 + NEBARI_BROAD_K + NEBARI_TIGHT_K)
        start = r_collar * 0.58
        for i in range(SURFACE_ROOTS):
            a = math.tau * (i + 0.18 * rnd11(i, 0x61)) / SURFACE_ROOTS
            reach = start + 0.030 + 0.026 * rnd01(i, 0x62)
            pts = []
            for k in range(5):
                f = k / 4.0
                out = start + (reach - start) * f
                x = math.cos(a) * out * 1.15
                y = math.sin(a) * out * 0.62
                # Ride the mound, then dive.  The soil is a dome, so a root on a
                # fixed z crossed the surface a centimetre from the trunk and
                # vanished; following soil_z_at keeps it a visible ridge out to
                # about half its reach and then buries its tip, which is what a
                # surface root actually does.
                z = (soil_z_at(self.pot, x, y) + 0.0020
                     - 0.026 * (f ** 2.5)
                     + 0.0012 * math.sin(f * 3.4 + i))
                # <= 0.35 * collar radius at the widest, so these read as roots
                # off the flare and never as a second trunk.
                rad = R_TRUNK * (0.62 - 0.46 * f) * (0.82 + 0.36 * rnd01(i, 0x63))
                pts.append((x, y, z, max(rad, R_MIN)))
            self.roots.append(pts)

    # -- branches -------------------------------------------------------------
    def _build_branches(self, t):
        skel = self.skel
        u = struct_u(t)
        steps = u * skel.total_steps
        girth = thicken(t)

        curve = self.branch_obj.data
        curve.splines.clear()

        for chain_idx, chain in enumerate(skel.chains):
            # How far this branch has grown, measured in curve parameter (q=i is
            # the end of the chain's i-th cell).  Each segment contributes
            # `i + its own progress`; the branch tip is the furthest of them.
            #
            # `max` of non-decreasing terms is non-decreasing, and when a new
            # segment is born it contributes (i+1) + 0 which is >= the i + p
            # it replaces.  So the cut point can only ever move forward: the
            # branch grows, it never retracts. That is the monotonicity proof.
            tip = -1.0
            for i, seg in enumerate(chain):
                p = clamp((steps - seg["birthStep"]) / EXTEND_STEPS, 0.0, 1.0)
                if p > 0.0:
                    reach = i + smoothstep(p)
                    if reach > tip:
                        tip = reach
            if tip <= 0.0:
                continue

            samples = skel.chain_poly[chain_idx]
            pts = []
            prev = None
            for q, pos, r_base in samples:
                if q > tip:
                    break
                pts.append((pos, r_base, q))
                prev = (q, pos, r_base)
            if prev is not None and prev[0] < tip:
                # Land the last point exactly on the cut, so the tip advances
                # continuously instead of in whole-cell jumps.
                nxt = None
                for q, pos, r_base in samples:
                    if q > tip:
                        nxt = (q, pos, r_base)
                        break
                if nxt is not None:
                    f = (tip - prev[0]) / (nxt[0] - prev[0])
                    pts.append((prev[1].lerp(nxt[1], f),
                                prev[2] + (nxt[2] - prev[2]) * f, tip))

            if len(pts) < 2:
                continue
            last_seg = len(chain) - 1
            chain_floor = r_floor(chain[0]["depth"])
            spline = curve.splines.new("POLY")
            spline.points.add(len(pts) - 1)
            for i, (pos, r_base, q) in enumerate(pts):
                # Two independent thinning factors, and the distinction matters.
                #
                # TAPER is about DISTANCE behind the tip: the last centimetre of
                # any shoot is a fine point. `tip - q` only grows, so this only
                # grows too.
                taper = clamp(TIP_TAPER + (1.0 - TIP_TAPER) * (tip - q) / TIP_LEN,
                              TIP_TAPER, 1.0)
                # AGE is about TIME since this piece of wood was born. Without
                # it a branch born at t=0.42 appeared at thicken(0.42)=0.80 of
                # final girth everywhere more than TIP_LEN behind its tip — a
                # blunt club-headed sausage as thick as the trunk. Each spline
                # sample belongs to exactly one skeleton segment (q=i is the end
                # of the chain's i-th cell), so it can carry that segment's own
                # birthStep and fatten from TIP_TAPER to 1.0 over AGE_STEPS.
                # steps rises with t and birthStep is constant => monotonic.
                # max(0, ...) because the trunk's buried nebari stub carries
                # negative q; those samples belong to segment 0 like the origin
                # they hang off, and a bare int(-0.9) would index chain[-1].
                seg = chain[max(0, min(int(q), last_seg))]
                age = clamp((steps - seg["birthStep"]) / AGE_STEPS, 0.0, 1.0)
                mature = TIP_TAPER + (1.0 - TIP_TAPER) * smootherstep(age)
                spline.points[i].co = (pos.x, pos.y, pos.z, 1.0)
                # The floor is depth-aware and, because a chain has exactly one
                # depth, CONSTANT along this tube — so it is still
                # max(non-decreasing, constant) and still monotonic.  It is what
                # guarantees that a branch which is bare for six minutes before
                # its pad opens is at least 5 px of wood while it waits.
                spline.points[i].radius = max(
                    r_base * girth * taper * mature, chain_floor)
            spline.use_smooth = True

        # Surface roots ride the trunk's own emergence.
        trunk_p = clamp((steps - skel.segments[0]["birthStep"]) / EXTEND_STEPS, 0.0, 1.0)
        if trunk_p > 0.0:
            # The roots ride the TRUNK's age clock, not a faster ramp of their
            # own. They used to reach full girth in EXTEND_STEPS*4 = 14 skeleton
            # steps while the trunk above them was still wire-thin, which read
            # as a fat bulb someone had pushed a wire into. On the same
            # AGE_STEPS clock as the wood, the nebari swells WITH the trunk.
            root_age = clamp(
                (steps - skel.segments[0]["birthStep"]) / AGE_STEPS, 0.0, 1.0)
            root_p = smootherstep(root_age)
            root_mature = TIP_TAPER + (1.0 - TIP_TAPER) * root_p
            for pts in self.roots:
                spline = curve.splines.new("POLY")
                spline.points.add(len(pts) - 1)
                x0, y0, z0, _ = pts[0]
                for i, (x, y, z, r) in enumerate(pts):
                    # Roots creep outward from the trunk as the trunk takes hold.
                    spline.points[i].co = (
                        x0 + (x - x0) * root_p,
                        y0 + (y - y0) * root_p,
                        z0 + (z - z0) * root_p,
                        1.0,
                    )
                    # The floor rides root_p too.  A CONSTANT floor here would
                    # leave a 2.1 mm bead of wood sitting on the soil at t=0,
                    # where the roots have not emerged yet and every point of
                    # the spline is still collapsed onto the trunk base.
                    # root_p is non-decreasing, so scaling by it is still
                    # max(non-decreasing, non-decreasing) and still monotonic.
                    spline.points[i].radius = max(
                        r * girth * root_mature * root_p, R_MIN * root_p)
                spline.use_smooth = True

    # -- leaves ---------------------------------------------------------------
    def _build_leaves(self, t):
        """Two clocks, not one.

        BIRTH is the skeleton's: a pad opens over LEAF_STEPS = 14 steps, which
        is the sync contract with the ASCII panel and is frozen.  MATURATION is
        this panel's own, and it is what the ASCII panel cannot show: after the
        pad has opened, its cards go on growing from LEAF_UNFURL_FLOOR to full
        size, more cards keep unfurling inside it, and the whole pad darkens
        from a spring flush to deep green — all of it finishing at MATURE_END.

        Measured on the rejected build, the right pad was pixel-frozen from
        t=0.09 to t=1.0: 0.19-0.39 luma of change per 110 frames.  It had
        finished being born and nothing else was wired up.

        MONOTONICITY.  The card's scale is `unfurl * grow * gate`.  `unfurl` is
        smootherstep of a clamped ramp in steps, `grow` is affine in `mat`,
        `gate` is smootherstep of a clamped ramp in `mat`, and `mat` is
        smootherstep of a clamped ramp in t with a CONSTANT per-site origin and
        span.  Every factor is non-negative and non-decreasing in t, so the
        product is non-decreasing in t.  Geometry still cannot shrink.
        """
        skel = self.skel
        steps = struct_u(t) * skel.total_steps
        verts, faces, ages = [], [], []

        for (birth, centre, u_axis, v_axis, length, width,
             t_birth, gate) in skel.leaf_cards:
            p = clamp((steps - birth) / LEAF_STEPS, 0.0, 1.0)
            if p <= 0.0:
                continue
            # This site's own maturation, 0 at its birth, 1 at MATURE_END.
            span = max(MATURE_END - t_birth, MATURE_MIN_SPAN)
            x = clamp((t - t_birth) / span, 0.0, 1.0)
            mat = (1.0 - MATURE_LINEAR) * smootherstep(x) + MATURE_LINEAR * x

            if gate > 0.0:
                gp = smootherstep(clamp((mat - gate) / LEAF_GATE_SPAN, 0.0, 1.0))
                if gp <= 0.0:
                    continue
            else:
                gp = 1.0

            # Leaves unfurl: they scale up from nothing, never appearing whole.
            # Two terms — a quick bud, then the pad proper. See LEAF_BUD_SIZE.
            bud = smoothstep(clamp(p / LEAF_BUD_P, 0.0, 1.0))
            openness = LEAF_BUD_SIZE * bud + (1.0 - LEAF_BUD_SIZE) * smootherstep(p)
            grow = LEAF_UNFURL_FLOOR + (1.0 - LEAF_UNFURL_FLOOR) * mat
            s = openness * grow * gp
            age = smootherstep(clamp((mat - gate) / LEAF_AGE_SPAN, 0.0, 1.0))
            _emit_leaf(verts, faces, centre, u_axis, v_axis,
                       length * s, width * s, LEAF_SIDES, attrs=ages, attr=age)

        rebuild_mesh(self.leaf_obj, verts, faces, smooth=False,
                     attr_name=LEAF_AGE_ATTR, attr_values=ages)

    # -- blossoms -------------------------------------------------------------
    def _build_blossoms(self, t):
        """Blossoms exist ONLY in the final stretch, and open on a stagger.

        BRIEF: "pale pink/white blossoms emerge only in the final stretch
        (t > 0.87) ... scaling in with easing so petals do NOT pop."

        Two things prevent popping.  smootherstep gives every flower zero
        velocity AND zero acceleration at the instant it starts, so no frame
        shows a flower arriving.  The per-flower stagger means the canopy
        blooms as a wave over ~8 minutes of model time rather than as a switch.
        """
        skel = self.skel
        verts, faces = [], []
        if t > BLOSSOM_START:
            tb = (t - BLOSSOM_START) / (1.0 - BLOSSOM_START)
            for i, (birth, centre, u_axis, v_axis, stagger) in enumerate(skel.blossom_sites):
                p = clamp((tb - stagger) / BLOSSOM_SPAN, 0.0, 1.0)
                if p <= 0.0:
                    continue
                s = smootherstep(p)
                r = BLOSSOM_R * (0.75 + 0.5 * rnd01(i, 0x71)) * s
                _emit_flower(verts, faces, centre, u_axis, v_axis, r, BLOSSOM_SIDES)
        rebuild_mesh(self.blossom_obj, verts, faces, smooth=False)

    # -- fallen petals --------------------------------------------------------
    def _build_petals(self, t):
        """A handful of petals on the soil and the rim once the tree is in bloom."""
        verts, faces = [], []
        if t > PETAL_FALL_START:
            tp = clamp((t - PETAL_FALL_START) / (1.0 - PETAL_FALL_START), 0.0, 1.0)
            hx = self.pot["hx"]
            hy = self.pot["hy"]
            for i in range(FALLEN_PETALS):
                p = clamp((tp - rnd01(i, 0x81) * 0.6) / 0.4, 0.0, 1.0)
                if p <= 0.0:
                    continue
                s = smootherstep(p)
                a = math.tau * rnd01(i, 0x82)
                rad = math.sqrt(rnd01(i, 0x83))
                x = math.cos(a) * hx * rad * 0.92
                y = math.sin(a) * hy * rad * 0.92
                z = self.pot["z_bed"] + 0.0135 * (1.0 - rad * rad) + 0.0016
                normal = Vector((rnd11(i, 0x84) * 0.25, rnd11(i, 0x85) * 0.25, 1.0))
                normal.normalize()
                u_axis, v_axis = _basis_from_normal(normal, rnd01(i, 0x86) * math.tau)
                _emit_leaf(verts, faces, Vector((x, y, z)), u_axis, v_axis,
                           BLOSSOM_R * 1.25 * s, BLOSSOM_R * 0.8 * s, 6)
        rebuild_mesh(self.petal_obj, verts, faces, smooth=False)

    # -- public ---------------------------------------------------------------
    def build(self, t):
        self._build_branches(t)
        self._build_leaves(t)
        self._build_blossoms(t)
        self._build_petals(t)


def _emit_fan(verts, faces, centre, u_axis, v_axis, outline, cup=0.0, attrs=None,
              attr=0.0):
    """Emit a polygon as a triangle fan around its own centre, optionally cupped.

    A fan, not an n-gon.  The blossom outline is a five-lobed star, and a star
    is CONCAVE: Blender's n-gon tessellator resolves concave polygons into
    overlapping triangles, which showed up in look-dev as hard pale shards
    spiking out of the canopy.  Fanning from the centre is correct for any
    star-convex outline, which both the leaf and the flower are by construction.

    `cup` lifts the centre vertex along the card's normal.  The fan already has
    that vertex, so curling the leaf costs nothing — and it matters: a perfectly
    flat card seen edge-on is a zero-width sliver that catches a specular
    highlight and reads as a hard bright streak in the canopy.  A cupped leaf
    always presents some curvature to the light, and looks like a leaf.
    """
    base = len(verts)
    apex = centre
    if cup:
        normal = u_axis.cross(v_axis)
        if normal.length > 1e-9:
            apex = centre + normal.normalized() * cup
    verts.append((apex.x, apex.y, apex.z))
    for (x, y) in outline:
        p = centre + u_axis * x + v_axis * y
        verts.append((p.x, p.y, p.z))
    n = len(outline)
    for k in range(n):
        faces.append((base, base + 1 + k, base + 1 + (k + 1) % n))
    if attrs is not None:
        attrs.extend([attr] * (len(verts) - base))


def _emit_leaf(verts, faces, centre, u_axis, v_axis, length, width, sides,
               attrs=None, attr=0.0):
    """A pointed-ellipse leaf card. Not a square — squares read as confetti."""
    if length <= 1e-6 or width <= 1e-6:
        return
    outline = []
    for k in range(sides):
        a = math.tau * k / sides
        sa, ca = math.sin(a), math.cos(a)
        # Narrow the card toward both tips so it reads as a leaf, not a disc.
        outline.append(((width * 0.5) * sa * (0.52 + 0.48 * abs(sa)),
                        (length * 0.5) * ca))
    _emit_fan(verts, faces, centre, u_axis, v_axis, outline, cup=length * LEAF_CUP,
              attrs=attrs, attr=attr)


def _emit_flower(verts, faces, centre, u_axis, v_axis, radius, sides):
    """A five-lobed blossom."""
    if radius <= 1e-6:
        return
    outline = []
    for k in range(sides):
        a = math.tau * k / sides
        r = radius * (0.72 + 0.28 * math.cos(5.0 * a))
        outline.append((r * math.cos(a), r * math.sin(a)))
    _emit_fan(verts, faces, centre, u_axis, v_axis, outline, cup=radius * BLOSSOM_CUP)


# =============================================================================
# RENDER SETUP
# =============================================================================


def configure_render(res_x, res_y, samples, exposure, file_format, jpeg_quality):
    scene = bpy.context.scene
    # BRIEF, measured: the EEVEE engine id in Blender 5.2 is 'BLENDER_EEVEE'.
    # 'BLENDER_EEVEE_NEXT' is the 4.x name and raises an enum error here.
    scene.render.engine = "BLENDER_EEVEE"

    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.use_overwrite = True
    scene.render.use_file_extension = True
    scene.render.image_settings.file_format = file_format
    scene.render.image_settings.color_mode = "RGB"
    if file_format == "PNG":
        scene.render.image_settings.color_depth = "8"
        scene.render.image_settings.compression = 15
    elif file_format == "JPEG":
        scene.render.image_settings.quality = jpeg_quality

    eevee = getattr(scene, "eevee", None)
    set_if(eevee, "taa_render_samples", samples)
    set_if(eevee, "taa_samples", max(16, samples // 4))
    set_if(eevee, "use_shadows", True)
    set_if(eevee, "use_soft_shadows", True)
    set_if(eevee, "shadow_ray_count", 2)
    set_if(eevee, "shadow_step_count", 6)
    set_if(eevee, "use_shadow_jitter_viewport", True)
    set_if(eevee, "use_raytracing", True)
    set_if(eevee, "use_gtao", True)             # 4.x name; absent on 5.2
    set_if(eevee, "gtao_distance", 0.08)
    set_if(eevee, "use_fast_gi", True)          # 5.x replacement: cheap near-field GI
    set_if(eevee, "fast_gi_distance", 0.10)
    set_if(eevee, "fast_gi_ray_count", 2)
    set_if(eevee, "fast_gi_step_count", 8)
    set_if(eevee, "clamp_surface_indirect", 6.0)
    set_if(eevee, "use_bokeh_jittered", True)
    set_if(eevee, "bokeh_max_size", 60.0)
    set_if(eevee, "volumetric_samples", 32)
    rt = getattr(eevee, "ray_tracing_options", None)
    set_if(rt, "use_denoise", True)
    set_if(rt, "screen_trace_quality", 0.25)
    set_if(rt, "resolution_scale", "2")

    vs = scene.view_settings
    if not set_if(vs, "view_transform", "AgX"):
        set_if(vs, "view_transform", "Filmic")
    for look in ("AgX - Medium High Contrast", "Medium High Contrast",
                 "AgX - Base Contrast", "None"):
        if set_if(vs, "look", look):
            break
    set_if(vs, "exposure", exposure)
    set_if(vs, "gamma", 1.0)


def configure_compositor():
    """A gentle bloom, so blossoms and rim light bleed rather than clip.

    Blender 5.2 moved the compositor out of `scene.node_tree` (gone) and into
    `scene.compositing_node_group`, a plain CompositorNodeTree wired between a
    NodeGroupInput and a NodeGroupOutput.  The Glare node's settings moved too:
    `glare_type`, `threshold`, `mix` and friends are no longer RNA properties,
    they are INPUT SOCKETS ('Type', 'Threshold', 'Strength', 'Size', ...).

    Both facts were measured on this build, not guessed.  The 4.x path is kept
    as a fallback, and the whole thing degrades to "no bloom" rather than
    killing a 50-minute render on frame 1.
    """
    scene = bpy.context.scene

    def dress_glare(glare):
        # Measured on 5.2: these menu sockets take the UI spelling ('Bloom',
        # 'High'), NOT the 4.x enum spelling ('BLOOM', 'HIGH'), which raises.
        if not set_socket(glare, "Type", "Bloom"):
            set_socket(glare, "Type", "Fog Glow")
        set_socket(glare, "Quality", "High")
        set_socket(glare, "Threshold", 0.86)
        set_socket(glare, "Strength", 0.070)
        set_socket(glare, "Smoothness", 0.45)
        set_socket(glare, "Size", 5)

    try:
        if hasattr(scene, "compositing_node_group"):
            ng = bpy.data.node_groups.new("BonsaiComposite", "CompositorNodeTree")
            ng.interface.new_socket("Image", in_out="OUTPUT",
                                    socket_type="NodeSocketColor")
            # The group MUST source its image from an explicit Render Layers
            # node.  Wiring a NodeGroupInput instead — which is what the 5.x UI
            # shows and what looks like the obvious translation of the old
            # tree — renders pure black in `--background`: EEVEE is never
            # invoked at all (frames drop to ~0.9 s) and every pixel comes back
            # 0.  Measured both ways on this build.
            rl = ng.nodes.new("CompositorNodeRLayers")
            rl.location = (-320, 0)
            try:
                rl.scene = scene
            except Exception:
                pass
            glare = ng.nodes.new("CompositorNodeGlare")
            glare.location = (0, 0)
            dress_glare(glare)
            gout = ng.nodes.new("NodeGroupOutput")
            gout.location = (340, 0)
            ng.links.new(rl.outputs["Image"], glare.inputs["Image"])
            ng.links.new(glare.outputs["Image"], gout.inputs["Image"])
            scene.compositing_node_group = ng
            return True

        scene.use_nodes = True                       # Blender 4.x fallback
        nt = scene.node_tree
        if nt is None:
            return False
        nt.nodes.clear()
        rl = nt.nodes.new("CompositorNodeRLayers")
        glare = nt.nodes.new("CompositorNodeGlare")
        set_if(glare, "glare_type", "BLOOM")
        set_if(glare, "quality", "HIGH")
        set_if(glare, "threshold", 0.86)
        set_if(glare, "mix", -0.82)
        comp = nt.nodes.new("CompositorNodeComposite")
        nt.links.new(rl.outputs["Image"], glare.inputs["Image"])
        nt.links.new(glare.outputs["Image"], comp.inputs["Image"])
        return True
    except Exception as exc:                        # pragma: no cover
        sys.stderr.write("[bonsai] compositor bloom unavailable: %r\n" % (exc,))
        return False


def purge_scene():
    """Empty the factory-startup scene of objects.

    DO NOT also remove `bpy.data.collections` here.  Measured on 5.2: deleting
    the default "Collection" leaves the scene renderable on its own but silently
    breaks the compositor — `scene.compositing_node_group`'s implicit render
    input goes dead, EEVEE is never invoked (frames drop from ~3.5 s to ~0.9 s),
    and every frame comes out pure black.  Removing only the objects avoids it
    entirely, and the empty default collection costs nothing.
    """
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


# =============================================================================
# CLI
# =============================================================================


def parse_args(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)

    ap = argparse.ArgumentParser(
        prog="bonsai_growth.py",
        description="Render the procedural bonsai. Geometry is a pure function of t.",
    )
    ap.add_argument("--skeleton", default=os.path.join(root, "public", "skeleton-42.json"),
                    help="skeleton JSON from tools/export-skeleton.mjs")
    ap.add_argument("--out", default=os.path.join(root, "public", "frames"),
                    help="output directory for the frame ladder")
    ap.add_argument("--frames", type=int, default=600,
                    help="total frames in the sequence (BRIEF N5 fixes this at 600)")
    ap.add_argument("--start", type=int, default=None, help="first frame index")
    ap.add_argument("--end", type=int, default=None, help="last frame index, inclusive")
    ap.add_argument("--frame-list", default=None,
                    help="explicit comma-separated frame indices, e.g. 109,130,272. "
                         "Overrides --start/--end and the --preview spread. Exists so "
                         "a look re-gate can shoot an arbitrary set of frames in ONE "
                         "--background session (see BRIEF: render sequentially).")
    ap.add_argument("--res", default=None,
                    help="WIDTHxHEIGHT, e.g. 900x1200 (the default)")
    ap.add_argument("--preview", action="store_true",
                    help="cheap look-dev pass: fewer samples, half res, and (unless "
                         "--start/--end are given) a spread of frames across all of t")
    ap.add_argument("--preview-count", type=int, default=12,
                    help="frames in a --preview spread")
    ap.add_argument("--samples", type=int, default=None,
                    help="EEVEE render samples (default 48 final / 24 preview)")
    ap.add_argument("--exposure", type=float, default=0.0, help="view-transform exposure")
    ap.add_argument("--fstop", type=float, default=3.5, help="camera aperture")
    ap.add_argument("--no-dof", action="store_true", help="disable depth of field")
    ap.add_argument("--no-bloom", action="store_true", help="disable compositor glare")
    ap.add_argument("--format", default="PNG", choices=("PNG", "JPEG"),
                    help="frame file format")
    ap.add_argument("--jpeg-quality", type=int, default=92)
    ap.add_argument("--log", default=None,
                    help="progress log (default <out>/render.log); one line per frame")

    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    return ap.parse_args(argv)


class Log(object):
    """Line-flushed progress log, so a background render can be polled."""

    def __init__(self, path):
        self.path = path
        directory = os.path.dirname(path)
        if directory and not os.path.isdir(directory):
            os.makedirs(directory)
        self.fh = open(path, "a", encoding="utf-8")

    def __call__(self, message):
        line = "[%s] %s" % (time.strftime("%H:%M:%S"), message)
        self.fh.write(line + "\n")
        self.fh.flush()
        try:
            os.fsync(self.fh.fileno())
        except Exception:
            pass
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    def close(self):
        try:
            self.fh.close()
        except Exception:
            pass


def main():
    args = parse_args(list(sys.argv))

    explicit_res = args.res is not None
    try:
        res_x, res_y = (int(v) for v in (args.res or "900x1200").lower().split("x"))
    except Exception:
        raise SystemExit("--res must look like 900x1200, got %r" % (args.res,))

    explicit_list = None
    if args.frame_list:
        explicit_list = sorted(set(
            max(0, min(int(v.strip()), args.frames - 1))
            for v in args.frame_list.split(",") if v.strip()
        ))
        if not explicit_list:
            raise SystemExit("--frame-list parsed to nothing: %r" % (args.frame_list,))

    preview_spread = None
    if args.preview:
        if args.samples is None:
            args.samples = 24
        if not explicit_res:
            res_x, res_y = res_x // 2, res_y // 2
        if explicit_list is None and args.start is None and args.end is None:
            n = max(args.preview_count, 2)
            preview_spread = [
                int(round(i * (args.frames - 1) / float(n - 1))) for i in range(n)
            ]
    if args.samples is None:
        args.samples = 48

    if explicit_list is not None:
        frame_indices = explicit_list
    elif preview_spread is not None:
        frame_indices = preview_spread
    else:
        start = 0 if args.start is None else args.start
        end = (args.frames - 1) if args.end is None else args.end
        start = max(0, min(start, args.frames - 1))
        end = max(start, min(end, args.frames - 1))
        frame_indices = list(range(start, end + 1))

    out_dir = os.path.abspath(args.out)
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    log = Log(args.log or os.path.join(out_dir, "render.log"))

    log("=" * 74)
    log("bonsai_growth.py | blender %s" % (bpy.app.version_string,))
    log("skeleton=%s" % (os.path.abspath(args.skeleton),))
    log("out=%s res=%dx%d samples=%d format=%s"
        % (out_dir, res_x, res_y, args.samples, args.format))
    log("frames=%d rendering %d frame(s): %s%s"
        % (args.frames, len(frame_indices), frame_indices[:6],
           " ..." if len(frame_indices) > 6 else ""))

    skel = Skeleton(args.skeleton)
    log("skeleton seed=%s segments=%d chains=%d leafCards=%d blossomSites=%d steps=%d"
        % (skel.seed, len(skel.segments), len(skel.chains), len(skel.leaf_cards),
           len(skel.blossom_sites), int(skel.total_steps)))

    purge_scene()
    configure_render(res_x, res_y, args.samples, args.exposure,
                     args.format, args.jpeg_quality)
    build_world()
    pot_obj, pot = build_pot(skel)
    build_soil(pot)

    # The camera is built BEFORE the floor and the backdrop on purpose.  The
    # floor's pool of light has to die before the bottom row of pixels, and the
    # backdrop's glow has to die before the floor's far edge crosses it, and
    # neither can be guaranteed without knowing the frame that will actually be
    # shot.  build_camera reads only the skeleton and the pot, so nothing here
    # is circular and the camera solve is bit-for-bit what it was.
    cam, cam_info = build_camera(skel, pot, res_x, res_y, args.fstop, not args.no_dof)
    floor_z = pot["z_foot"] - 0.0005
    build_backdrop(skel, cam_info["location"], floor_z)
    build_floor(skel, floor_z, pot, cam_info)
    build_lights(skel, pot)

    log("camera FIXED at %s rot=%s lens=%.1fmm" %
        (cam_info["location"], cam_info["rotation_deg"], cam_info["lens_mm"]))
    log("framing frame_w=%.4f frame_h=%.4f  pot_rim_v=%.4f canopy_top_v=%.4f "
        "ground_v=%.4f  (v = fraction down from top of frame; M3 alignment uses these)"
        % (cam_info["frame_w"], cam_info["frame_h"], cam_info["pot_rim_v"],
           cam_info["canopy_top_v"], cam_info["ground_v"]))
    log("side margins: t=1 content spans u=%.4f..%.4f (need >= %.2f .. <= %.2f); "
        "floor meets frame bottom at y=%.4f"
        % (cam_info["content_left_u"], cam_info["content_right_u"],
           SIDE_MARGIN_MIN, 1.0 - SIDE_MARGIN_MIN,
           cam_info["floor_y_at_frame_bottom"]))

    with open(os.path.join(out_dir, "camera.json"), "w", encoding="utf-8") as fh:
        json.dump(cam_info, fh, indent=2)

    rig = TreeRig(skel, make_bark_material(), make_leaf_material(),
                  make_blossom_material("Blossom"),
                  make_blossom_material("FallenPetal", emission=0.02), pot)

    if not args.no_bloom:
        configure_compositor()

    scene = bpy.context.scene
    denom = float(max(args.frames - 1, 1))
    t0 = time.time()
    done = 0

    for index in frame_indices:
        t = index / denom
        frame_start = time.time()

        rig.build(t)

        scene.frame_set(1)          # nothing is keyed; this is only bookkeeping
        # frame_NNNN, with an underscore: that is what tools/contact-sheet.py
        # globs for and what proof/M2/preview already holds.
        scene.render.filepath = os.path.join(out_dir, "frame_%04d" % index)
        bpy.ops.render.render(write_still=True)

        done += 1
        now = time.time()
        elapsed = now - t0
        per = elapsed / done
        remaining = per * (len(frame_indices) - done)
        log("frame %04d/%04d t=%.5f  %5.2fs  elapsed=%7.1fs  eta=%7.1fs  -> %s"
            % (index, frame_indices[-1], t, now - frame_start, elapsed, remaining,
               os.path.basename(scene.render.filepath)))

    log("DONE %d frame(s) in %.1fs (%.2fs/frame)"
        % (done, time.time() - t0, (time.time() - t0) / max(done, 1)))
    log("=" * 74)
    log.close()


if __name__ == "__main__":
    main()
