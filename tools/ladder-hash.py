#!/usr/bin/env python3
"""Refined duplicate-frame + N7-liveness pass over the 600-frame ladder.

Why this exists separately from ladder-integrity.py:

1. A plain 8x8 dhash over the FULL 900x1200 dark-field frame is useless here.
   The tree occupies a minority of a mostly-black plate, so the 8x8 downsample
   averages the subject away and 577/599 adjacent pairs collide.  That is a
   hash-resolution artifact, NOT a stalled growth function.  Here the hash is
   taken over the CONTENT BOUNDING BOX after a gamma lift, at 16x16 (256 bits),
   which is what a perceptual hash of this image actually needs to be.

2. N7's acceptance test ("two consecutive PREVIEW frames, mean|delta| >= 0.8/255")
   is defined at the preview stride.  proof/M2/preview holds 12 frames across the
   600-frame span => stride 55.  Applying the 0.8 threshold to a stride-1 pair of
   the final ladder would be comparing against a gap 55x smaller than the one the
   number was measured on.  Both strides are reported.
"""
import json
import os
import sys
from collections import deque

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAMES = os.path.join(ROOT, "public", "frames")
PROOF = os.path.join(ROOT, "proof", "M2")
N = 600
PREVIEW_STRIDE = 55       # proof/M2/preview: frames 0,54,109,...,599
N7_LO, N7_HI = 0.55, 0.87
N7_MIN = 0.8              # mean |delta| per 255


def load(i):
    p = os.path.join(FRAMES, "frame-%04d.jpg" % i)
    return np.asarray(Image.open(p).convert("L"), dtype=np.uint8)


def content_box():
    """Union bbox of lit content across the sequence endpoints + midpoints."""
    acc = None
    for i in (0, 150, 300, 450, 599):
        g = load(i).astype(np.float32)
        m = g >= 24
        acc = m if acc is None else (acc | m)
    ys, xs = np.where(acc)
    pad = 12
    y0, y1 = max(0, ys.min() - pad), min(acc.shape[0], ys.max() + 1 + pad)
    x0, x1 = max(0, xs.min() - pad), min(acc.shape[1], xs.max() + 1 + pad)
    return int(y0), int(y1), int(x0), int(x1)


def phash_bits(gray, box, size=16):
    """Gamma-lifted, content-cropped difference hash -> size*(size) bit ints."""
    y0, y1, x0, x1 = box
    crop = gray[y0:y1, x0:x1].astype(np.float32) / 255.0
    crop = np.power(crop, 1.0 / 2.6) * 255.0          # lift the dark field
    im = Image.fromarray(crop.astype(np.uint8)).resize(
        (size + 1, size), Image.LANCZOS)
    a = np.asarray(im, dtype=np.int16)
    dbits = (a[:, 1:] > a[:, :-1]).flatten()
    b = np.asarray(im.resize((size, size), Image.LANCZOS), dtype=np.float32)
    abits = (b > b.mean()).flatten()
    return dbits, abits


def tohex(bits):
    v = 0
    for x in bits:
        v = (v << 1) | int(x)
    return "%0*x" % (len(bits) // 4, v)


def main():
    box = content_box()
    print("content box (y0,y1,x0,x1) = %s  -> %dx%d" %
          (box, box[3] - box[2], box[1] - box[0]), file=sys.stderr)

    out = []
    buf = deque(maxlen=PREVIEW_STRIDE + 1)
    prev_d = prev_a = None
    for i in range(N):
        g = load(i)
        dbits, abits = phash_bits(g, box)
        dh, ah = tohex(dbits), tohex(abits)
        rec = dict(index=i, t=i / float(N - 1), dhash16=dh, ahash16=ah)
        if prev_d is not None:
            rec["dhash_hamming_prev"] = int((dbits != prev_d).sum())
            rec["ahash_hamming_prev"] = int((abits != prev_a).sum())
            d = np.abs(g.astype(np.int16) - buf[-1].astype(np.int16))
            rec["delta1_mean"] = float(d.mean())
        prev_d, prev_a = dbits, abits
        buf.append(g)
        if len(buf) == PREVIEW_STRIDE + 1:
            d = np.abs(g.astype(np.int16) - buf[0].astype(np.int16))
            rec["delta55_mean"] = float(d.mean())
            rec["delta55_from"] = i - PREVIEW_STRIDE
        out.append(rec)
        if (i + 1) % 100 == 0:
            print("  ...%d/%d" % (i + 1, N), file=sys.stderr)

    json.dump(out, open(os.path.join(PROOF, "_hash.json"), "w"))

    dh_dupes = [r["index"] for r in out
                if r.get("dhash_hamming_prev") == 0]
    ah_dupes = [r["index"] for r in out
                if r.get("ahash_hamming_prev") == 0]
    print("adjacent dhash16 collisions: %d" % len(dh_dupes))
    print("adjacent ahash16 collisions: %d" % len(ah_dupes))
    if dh_dupes:
        print("  at: %s" % dh_dupes[:40])

    n7 = [r for r in out if "delta55_mean" in r
          and N7_LO <= r["t"] <= N7_HI]
    vals = [r["delta55_mean"] for r in n7]
    print("N7 stride-%d pairs in t[%.2f,%.2f]: %d  min=%.3f med=%.3f max=%.3f"
          % (PREVIEW_STRIDE, N7_LO, N7_HI, len(vals), min(vals),
             float(np.median(vals)), max(vals)))
    print("N7 verdict: %s (threshold %.1f/255)"
          % ("PASS" if min(vals) >= N7_MIN else "FAIL", N7_MIN))


if __name__ == "__main__":
    main()
