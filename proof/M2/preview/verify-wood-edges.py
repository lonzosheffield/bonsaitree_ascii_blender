#!/usr/bin/env python3
"""Round-3 look gate, note 2, the pixel half: is there still a cool rim streak
down the edge of every branch, and is the base still a bright bulb?

    python verify-wood-edges.py <frame-dir> [label]

Three measurements, each aimed at one sentence of the note.

[E1] "a bright cool-cyan rim runs along the edge of every branch".
     A rim streak lives on the EDGE of the wood, so measure there specifically:
     take the wood mask, erode it, and keep the ring the erosion removed.  For
     those edge pixels report the distribution of B-R.  A cyan line shows up as
     a fat positive tail; wood lit by a warm-neutral rim keeps B-R negative
     even on the lit edge.

[E2] "the bark albedo is a fine white speckle that aliases into static".
     Speckle is high-frequency energy, so compare the local standard deviation
     of luma on wood between the two builds.  It falls when the noise stops
     being per-pixel.

[E3] "a light bulb at the base".  A lit end-cap is brighter than the wood above
     it; bark running into soil is not.  Report the mean luma of wood inside
     the base box against the mean luma of wood in a band up the trunk, plus
     the share of base-box wood hotter than 1.6x the trunk mean.
"""
import glob
import os
import re
import sys

import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722])
BASE_BOX = (0.333, 0.583, 0.775, 0.975)      # u0, u1, v0, v1 — trunk/soil junction
TRUNK_BAND = (0.700, 0.780)                  # v0, v1 — clear trunk above it


def wood_mask(a, L, P):
    """Lit wood: changed from the clean plate, bright enough to be lit, and
    neither a leaf nor a petal.

    THE EXCLUSIONS MATTER, and a careless one hides the very thing being
    measured.  "Not a leaf" cannot be `G <= R`, because a COOL RIM ON WOOD also
    puts G above R — that test would throw away exactly the pixels the note is
    about and report a clean bill of health on any build.  A leaf is
    STRONGLY green: G above BOTH of the other channels by a clear margin.  A
    cyan rim has G and B close together, so it survives this mask and gets
    counted, which is the point.
    """
    leaf = (a[..., 1] > a[..., 0] + 10) & (a[..., 1] > a[..., 2] + 10)
    petal = (L > 150.0) & (np.abs(a[..., 0] - a[..., 2]) < 40)
    return ((L - P) > 8.0) & (L > 45.0) & ~leaf & ~petal


def local_std(a, k):
    p = np.pad(a, k // 2, mode="edge")
    s1 = np.cumsum(np.cumsum(p, 0), 1)
    s2 = np.cumsum(np.cumsum(p * p, 0), 1)

    def win(s):
        s = np.pad(s, ((1, 0), (1, 0)))
        return s[k:, k:] - s[:-k, k:] - s[k:, :-k] + s[:-k, :-k]

    n = float(k * k)
    m1, m2 = win(s1) / n, win(s2) / n
    return np.sqrt(np.maximum(m2 - m1 * m1, 0.0))


def erode(m):
    e = m.copy()
    e[1:, :] &= m[:-1, :]
    e[:-1, :] &= m[1:, :]
    e[:, 1:] &= m[:, :-1]
    e[:, :-1] &= m[:, 1:]
    return e


def main(d, label=""):
    paths = sorted(glob.glob(os.path.join(d, "frame_*.png")))
    if not paths:
        sys.exit("no frame_*.png in %s" % d)
    imgs = {}
    for p in paths:
        i = int(re.search(r"frame_(\d+)", os.path.basename(p)).group(1))
        imgs[i] = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
    keys = sorted(imgs)
    plate = imgs[keys[0]]
    h, w, _ = plate.shape
    k = 5 if w >= 800 else 3
    P = plate @ LUMA
    print("== %s%s  %dx%d ==" % (label, d, w, h))

    print("\n[E1] BRANCH-EDGE HUE  (wood edge pixels, luma > 45; B-R, 8-bit)")
    print("     a saturated cyan line reads as a long positive tail")
    print("     %6s %8s %9s %9s %9s %9s %9s" %
          ("frame", "edge px", "mean B-R", "p90", "p99", "max", "%B>R"))
    for i in keys[1:]:
        a = imgs[i]
        L = a @ LUMA
        wood = wood_mask(a, L, P)
        edge = wood & ~erode(wood)
        if edge.sum() < 60:
            print("     f%04d  (too little wood edge: %d px)" % (i, edge.sum()))
            continue
        bmr = (a[..., 2] - a[..., 0])[edge]
        print("     f%04d %8d %9.2f %9.2f %9.2f %9.2f %8.2f%%"
              % (i, edge.sum(), bmr.mean(), np.percentile(bmr, 90),
                 np.percentile(bmr, 99), bmr.max(), 100.0 * (bmr > 0).mean()))

    print("\n[E2] BARK HIGH-FREQUENCY ENERGY  (mean local std of luma on lit wood,"
          " %dx%d window)" % (k, k))
    for i in keys[1:]:
        a = imgs[i]
        L = a @ LUMA
        # INTERIOR wood only.  A silhouette edge against a black backdrop has a
        # local std of 40+ whatever the material is doing, so measuring the
        # whole mask measures the outline, not the texture.  Two erosions strip
        # the boundary ring and leave the bark itself.
        wood = erode(erode(wood_mask(a, L, P)))
        sd = local_std(L, k)
        if wood.sum() < 200:
            continue
        print("     f%04d  interior px=%7d   mean local std=%6.3f   p95=%6.3f"
              % (i, wood.sum(), sd[wood].mean(), np.percentile(sd[wood], 95)))

    print("\n[E3] THE BASE: bulb or flare?")
    u0, u1, v0, v1 = BASE_BOX
    x0, x1, y0, y1 = int(u0 * w), int(u1 * w), int(v0 * h), int(v1 * h)
    print("     base box px x=%d..%d y=%d..%d, trunk band v=%.2f..%.2f"
          % (x0, x1, y0, y1, TRUNK_BAND[0], TRUNK_BAND[1]))
    print("     %6s %9s %10s %10s %9s %12s" %
          ("frame", "base px", "base mean", "trunk mean", "ratio", "hot share"))
    for i in keys[1:]:
        a = imgs[i]
        L = a @ LUMA
        wood = ((L - P) > 8.0) & (L > 25.0)
        base = np.zeros_like(wood)
        base[y0:y1, x0:x1] = True
        base &= wood
        band = np.zeros_like(wood)
        band[int(TRUNK_BAND[0] * h):int(TRUNK_BAND[1] * h), :] = True
        band &= wood
        if base.sum() < 60 or band.sum() < 60:
            print("     f%04d  (not enough wood yet)" % i)
            continue
        bm, tm = L[base].mean(), L[band].mean()
        hot = (L[base] > 1.6 * tm).mean()
        print("     f%04d %9d %10.2f %10.2f %9.3f %11.2f%%"
              % (i, base.sum(), bm, tm, bm / tm, 100.0 * hot))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] + " " if len(sys.argv) > 2 else "")
