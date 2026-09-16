"""Offline girth audit: recompute the per-point tube radius exactly as
TreeRig._build_branches does, without rendering, and report

  (a) monotonicity of every sampled radius over t,
  (b) the branch_r / trunk_r ratio table for the primary branches, measured at
      the junction against the trunk AT THAT HEIGHT (round-2 look gate),
  (c) the thinnest leaf-bearing twig at t=1, and
  (d) the thinnest BARE wood on each preview frame, in pixels at 900x1200.

Run inside Blender:
    blender -b --factory-startup --python verify-girth-monotonic.py
"""
import os, sys
HERE = r"C:\aha\ascii art\blender"
sys.path.insert(0, HERE)
import bonsai_growth as B

skel = B.Skeleton(r"C:\aha\ascii art\public\skeleton-42.json")
FRAMES = 600

# Pixel scale of the shipped framing: 900 px across frame_w metres.  This is
# what turns a radius in metres into the "no bare branch thinner than 5 px"
# acceptance the re-gate asks for.  frame_w is solved from the skeleton and the
# pot exactly as build_camera does it, so this needs no render to be true.
POT_Z_RIM = -0.022            # from proof/M2/preview/camera.json (camera is frozen)
FRAME_H = (skel.max_z - POT_Z_RIM) / (B.TARGET_POT_RIM_V - B.TARGET_CANOPY_TOP_V)
FRAME_W = FRAME_H / (1200.0 / 900.0)
PX_PER_M = 900.0 / FRAME_W


def radii_at(index):
    """{(chain_idx, q): (radius, pos)} for every spline point at this frame."""
    t = index / float(FRAMES - 1)
    u = B.struct_u(t)
    steps = u * skel.total_steps
    girth = B.thicken(t)
    out = {}
    for ci, chain in enumerate(skel.chains):
        tip = -1.0
        for i, seg in enumerate(chain):
            p = B.clamp((steps - seg["birthStep"]) / B.EXTEND_STEPS, 0.0, 1.0)
            if p > 0.0:
                tip = max(tip, i + B.smoothstep(p))
        if tip <= 0.0:
            continue
        last_seg = len(chain) - 1
        floor = B.r_floor(chain[0]["depth"])
        for q, pos, r_base in skel.chain_poly[ci]:
            if q > tip:
                break
            taper = B.clamp(B.TIP_TAPER + (1.0 - B.TIP_TAPER) * (tip - q) / B.TIP_LEN,
                            B.TIP_TAPER, 1.0)
            # max(0, ...) mirrors TreeRig._build_branches: the trunk's buried
            # nebari stub carries negative q and belongs to segment 0.
            seg = chain[max(0, min(int(q), last_seg))]
            age = B.clamp((steps - seg["birthStep"]) / B.AGE_STEPS, 0.0, 1.0)
            mature = B.TIP_TAPER + (1.0 - B.TIP_TAPER) * B.smootherstep(age)
            out[(ci, q)] = (max(r_base * girth * taper * mature, floor), pos)
    return out


print("CONSTANTS  R_TRUNK=%.4f  R_MIN=%.5f  R_FLOOR_BY_DEPTH=%s" %
      (B.R_TRUNK, B.R_MIN, B.R_FLOOR_BY_DEPTH))
print("           DEPTH_TAPER=%.2f  TYPE_GIRTH.shootLeft=%.2f  TIP_TAPER=%.2f  "
      "AGE_STEPS=%.1f  CURVE_TENSION=%.2f  NODE_MOVE_MAX_CELLS=%.2f"
      % (B.DEPTH_TAPER, B.TYPE_GIRTH["shootLeft"], B.TIP_TAPER, B.AGE_STEPS,
         B.CURVE_TENSION, B.NODE_MOVE_MAX_CELLS))
print("           total_steps=%d  frame_w=%.5f m  scale=%.1f px/m at 900x1200"
      % (skel.total_steps, FRAME_W, PX_PER_M))

# ---------------------------------------------------------------- monotonic
prev = {}
worst = 0.0
worst_at = None
for index in range(0, FRAMES, 2):
    cur = radii_at(index)
    for k, (r, _) in cur.items():
        if k in prev:
            d = prev[k][0] - r
            if d > worst:
                worst, worst_at = d, (index, k)
    prev = cur
print("\nMONOTONIC radius check over 300 sampled frames: worst shrink = %.3e m at %s"
      % (worst, worst_at))
print("  (any value <= 1e-12 is float noise, not a shrink)")

# ------------------------------------------- deviation from the literal grid
# The control-point corner cut is allowed to move the path off cbonsai's cell
# centres by up to ~0.45 of a cell.  Measure it, in cells, so the budget is a
# number and not a hope.  Compare each chain's control polygon after the cut
# against the raw grid points it came from.
worst_dev = 0.0
worst_dev_chain = None
for ci, chain in enumerate(skel.chains):
    raw = [(chain[0]["x0"], chain[0]["y0"])] + [(s["x1"], s["y1"]) for s in chain]
    poly = skel.chain_poly[ci]
    # the sample at q = i is the (possibly moved) control point i
    for i, (gx, gy) in enumerate(raw):
        for q, pos, _r in poly:
            if abs(q - i) < 1e-6:
                wx = (gx - skel.root_x) * B.COL_W
                wz = (skel.ground_row - gy) * B.ROW_H
                dx_cells = (pos.x - wx) / B.COL_W
                dz_cells = (pos.z - wz) / B.ROW_H
                dev = (dx_cells ** 2 + dz_cells ** 2) ** 0.5
                if dev > worst_dev:
                    worst_dev, worst_dev_chain = dev, (ci, i)
                break
print("\nPATH DEVIATION from the literal cbonsai cell after the corner cut:")
print("  worst sampled = %.3f cell  at chain %s   (budget 0.45)"
      % (worst_dev, worst_dev_chain))
print("  worst node displacement reported by _smooth_nodes = %.3f cell (cap %.2f)"
      % (skel.worst_cut_cells, B.NODE_MOVE_MAX_CELLS))

# ------------------------------------------------ branch/trunk ratio at t=1
# A "first-order branch" is a chain whose head hangs off the trunk (depth 0).
# Measure it just past its junction (q = 1.0, the end of its own first cell —
# q = 0 still carries the PARENT's radius by construction) against the trunk
# radius at the same height.
R1 = radii_at(FRAMES - 1)
trunk_pts = [(pos.z, r) for (ci, q), (r, pos) in R1.items()
             if skel.chains[ci][0]["depth"] == 0]


def trunk_r_at(z):
    return min(trunk_pts, key=lambda p: abs(p[0] - z))[1]


rows = []
for ci, chain in enumerate(skel.chains):
    head = chain[0]
    if head["depth"] != 1 or head["parent"] < 0:
        continue
    if skel.by_id[head["parent"]]["depth"] != 0:
        continue
    pt = [(q, r, pos) for (c, q), (r, pos) in R1.items() if c == ci and 0.9 <= q <= 1.1]
    if not pt:
        continue
    q, r, pos = pt[0]
    tr = trunk_r_at(pos.z)
    reach = max(abs(p[1].x) for p in skel.chain_poly[ci])
    rows.append((reach, ci, head["type"], head["birthStep"], len(chain),
                 r * 1000.0, tr * 1000.0, r / tr))

rows.sort(reverse=True)
print("\nFIRST-ORDER BRANCH GIRTH AT ITS JUNCTION vs THE TRUNK AT THAT HEIGHT, t=1")
print("  (re-gate requires ratio >= 0.25)")
print("  %5s %12s %9s %5s %12s %12s %8s" %
      ("chain", "type", "birth", "segs", "branch_r_mm", "trunk_r_mm", "ratio"))
fails = 0
for reach, ci, typ, birth, n, br, tr, ratio in rows:
    flag = "" if ratio >= 0.25 else "   <-- UNDER 0.25"
    if ratio < 0.25:
        fails += 1
    print("  %5d %12s %9d %5d %12.3f %12.3f %8.3f%s"
          % (ci, typ, birth, n, br, tr, ratio, flag))
print("  %d of %d first-order branches under 0.25" % (fails, len(rows)))

# ------------------------- the branch Fable measured: the right pad's primary
print("\nTHE RIGHT-PAD PRIMARY (the branch measured at 3.0 mm / ratio 0.11 before)")
# Fable measured the chain that carries the right-hand pad: the one reaching
# furthest to camera-RIGHT, at ANY depth, not only depth 1.
trunk_base = max(r for (c, q), (r, _) in R1.items()
                 if skel.chains[c][0]["depth"] == 0 and q < 6.0) * 1000.0
best = None
for ci, chain in enumerate(skel.chains):
    reach = max(p[1].x for p in skel.chain_poly[ci])
    if best is None or reach > best[0]:
        best = (reach, ci)
reach, ci = best
chain = skel.chains[ci]
pt = sorted((q, r, pos) for (c, q), (r, pos) in R1.items() if c == ci)
q, r, pos = pt[min(4, len(pt) - 1)]      # just past the junction
print("  chain %d (%s, depth %d, birthStep %d, %d cells, reaches x=%.3f m)"
      % (ci, chain[0]["type"], chain[0]["depth"], chain[0]["birthStep"],
         len(chain), reach))
print("  branch_r = %.3f mm   trunk_r at the nebari = %.3f mm   ratio = %.3f"
      % (r * 1000.0, trunk_base, r / (trunk_base / 1000.0)))
print("  trunk_r at THAT HEIGHT = %.3f mm   ratio = %.3f"
      % (trunk_r_at(pos.z) * 1000.0, r / trunk_r_at(pos.z)))
print("  (rejected build: 3.0 mm against 27.8 mm, ratio 0.11)")
print("\nTRUNK RADIUS AT t=1 (unchanged by this round; depth 0 is not tapered): "
      "%.3f mm at the nebari" % trunk_base)

# ------------------------------------------- thinnest leaf-bearing twig, t=1
leaf_segs = set(l["segmentId"] for l in skel.leaves)
thin = None
for (ci, q), (r, pos) in R1.items():
    chain = skel.chains[ci]
    seg = chain[min(int(q), len(chain) - 1)]
    if seg["id"] in leaf_segs:
        if thin is None or r < thin[0]:
            thin = (r, ci, q, seg["type"])
print("\nTHINNEST LEAF-BEARING TWIG at t=1: %.3f mm radius (%.1f px wide at "
      "900x1200) on chain %d %s  (re-gate requires >= 1.6 mm)"
      % (thin[0] * 1000.0, thin[0] * 2 * PX_PER_M, thin[1], thin[3]))

# ------------------------------------- thinnest BARE wood on a preview frame
# "Bare" = a spline point with no leaf card within LEAF_CLUSTER_R * 1.6 of it.
# Those are the frames-long naked filaments the re-gate is about.
PREVIEW = [0, 54, 109, 130, 163, 218, 272, 290, 327, 381, 436, 490, 545, 599]
print("\nTHINNEST BARE WOOD PER PREVIEW FRAME (bare = no leaf card within %.0f mm)"
      % (B.LEAF_CLUSTER_R * 1.6 * 1000.0))
print("  (re-gate requires >= 5.0 px at 900x1200)")
print("  %6s %8s %14s %10s" % ("frame", "t", "thinnest_mm", "px_wide"))
reach_r = B.LEAF_CLUSTER_R * 1.6
worst_px = 1e9
for index in PREVIEW:
    t = index / float(FRAMES - 1)
    steps = B.struct_u(t) * skel.total_steps
    # A card only counts as CLOTHING once it is a quarter of the way open;
    # a card that technically exists at 1% of its size hides nothing.
    live_leaves = [c[1] for c in skel.leaf_cards
                   if steps > c[0] + 0.25 * B.LEAF_STEPS]
    R = radii_at(index)
    thinnest = None
    for (ci, q), (r, pos) in R.items():
        bare = True
        for lc in live_leaves:
            if (lc - pos).length < reach_r:
                bare = False
                break
        if bare and (thinnest is None or r < thinnest):
            thinnest = r
    if thinnest is None:
        print("  %6d %8.4f %14s %10s" % (index, t, "(all clothed)", "-"))
        continue
    px = thinnest * 2 * PX_PER_M
    worst_px = min(worst_px, px)
    print("  %6d %8.4f %14.3f %10.2f%s"
          % (index, t, thinnest * 1000.0, px, "" if px >= 5.0 else "  <-- UNDER 5 px"))
print("  worst across the preview ladder: %.2f px" % worst_px)
