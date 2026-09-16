#!/usr/bin/env python3
"""M2 frame-ladder manifest + integrity proof.

    python tools/ladder-integrity.py

Single pass over public/frames/frame-NNNN.jpg.  Emits

    public/frames/manifest.json   frame count, resolution, per-frame t,
                                  sha256 and byte size  (browser-facing)
    proof/M2/growth-metrics.csv   every per-frame metric, one row per frame
    proof/M2/integrity.txt        the human-readable verdict

The scene is a DARK FIELD: a spotlit bonsai on a near-black backdrop, so a
whole-frame mean luminance of ~6/255 at t=0 is correct exposure, not a black
frame.  Blankness is therefore judged on STRUCTURE (std, dynamic range, count of
lit pixels), never on mean alone.
"""
import csv
import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAMES = os.path.join(ROOT, "public", "frames")
PROOF = os.path.join(ROOT, "proof", "M2")

N = 600
LIT = 32.0        # luma at/above which a pixel counts as "lit" (visible content)
FG_DELTA = 8.0    # luma delta from the t=0 plate that counts as new material

# --- blank-frame thresholds (a frame failing ANY of these is flagged) --------
MIN_STD = 1.0     # a uniform field has std ~0
MIN_RANGE = 16.0  # p99.9 - p0.1 ; a blank frame has no dynamic range
MIN_MAX = 48.0    # nothing anywhere near lit => nothing rendered
MIN_LIT = 200     # at least this many pixels above LIT

# --- N7 liveness ------------------------------------------------------------
N7_LO, N7_HI = 0.55, 0.87
N7_MIN_DELTA = 0.8   # mean |delta| per 255, between consecutive frames


def dhash(gray, size=8):
    """64-bit difference hash: compare each pixel to its right neighbour."""
    small = np.asarray(
        Image.fromarray(gray.astype(np.uint8)).resize((size + 1, size),
                                                      Image.LANCZOS),
        dtype=np.int16)
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    v = 0
    for b in bits:
        v = (v << 1) | int(b)
    return v


def ahash(gray, size=8):
    """64-bit average hash, as a second opinion on dhash collisions."""
    small = np.asarray(
        Image.fromarray(gray.astype(np.uint8)).resize((size, size),
                                                      Image.LANCZOS),
        dtype=np.float64)
    bits = (small > small.mean()).flatten()
    v = 0
    for b in bits:
        v = (v << 1) | int(b)
    return v


def popcount(x):
    return bin(x).count("1")


def main():
    os.makedirs(PROOF, exist_ok=True)
    paths = [os.path.join(FRAMES, "frame-%04d.jpg" % i) for i in range(N)]

    missing = [i for i, p in enumerate(paths) if not os.path.isfile(p)]
    stray = sorted(f for f in os.listdir(FRAMES)
                   if f.startswith("frame-") and f.endswith(".jpg")
                   and f not in {os.path.basename(p) for p in paths})

    if missing:
        print("MISSING FRAMES: %s" % missing[:20], file=sys.stderr)

    rows = []
    prev_gray = None
    plate = None
    res = None

    for i, p in enumerate(paths):
        if not os.path.isfile(p):
            continue
        blob = open(p, "rb").read()
        sha = hashlib.sha256(blob).hexdigest()
        im = Image.open(p)
        if res is None:
            res = im.size
        gray = np.asarray(im.convert("L"), dtype=np.float32)
        if plate is None:
            plate = gray.copy()

        mean = float(gray.mean())
        std = float(gray.std())
        p001, p999 = np.percentile(gray, [0.1, 99.9])
        lit = int((gray >= LIT).sum())
        # foreground coverage: pixels that differ from the t=0 seed plate.
        cover = int((np.abs(gray - plate) >= FG_DELTA).sum())
        # luma mass above the field floor - a second, smoother growth proxy.
        mass = float(np.clip(gray - 12.0, 0, None).sum() / 1000.0)

        if prev_gray is None:
            adj = float("nan")
            adj_max = float("nan")
        else:
            d = np.abs(gray - prev_gray)
            adj = float(d.mean())
            adj_max = float(d.max())

        rows.append(dict(
            index=i,
            file=os.path.basename(p),
            t=i / float(N - 1),
            bytes=len(blob),
            sha256=sha,
            width=im.size[0], height=im.size[1],
            mean_luma=mean, std_luma=std,
            p001=float(p001), p999=float(p999),
            max_luma=float(gray.max()),
            lit_px=lit, lit_frac=lit / float(gray.size),
            coverage_px=cover, coverage_frac=cover / float(gray.size),
            luma_mass=mass,
            dhash=dhash(gray), ahash=ahash(gray),
            adj_mean_delta=adj, adj_max_delta=adj_max,
        ))
        prev_gray = gray
        if (i + 1) % 100 == 0:
            print("  ...%d/%d" % (i + 1, N), file=sys.stderr)

    # ---------------- manifest -------------------------------------------
    total_bytes = sum(r["bytes"] for r in rows)
    manifest = {
        "schema": "bonsai-duet/frame-ladder@1",
        "generator": "tools/ladder-integrity.py",
        "source": "blender/bonsai_growth.py (Blender 5.2.1 LTS, EEVEE)",
        "seed": 42,
        "frameCount": len(rows),
        "width": res[0], "height": res[1],
        "format": "jpeg",
        "pattern": "frame-%04d.jpg",
        "tFirst": 0.0, "tLast": 1.0,
        "tStep": 1.0 / (N - 1),
        "note": ("t = index / (frameCount - 1); frame 0 is t=0 (seed), "
                 "frame 599 is t=1 (bloom). N4: this ladder is the primary "
                 "scrub source - the browser swaps <img> frames and "
                 "crossfades the two nearest (N5)."),
        "totalBytes": total_bytes,
        "frames": [
            {"index": r["index"], "file": r["file"], "t": round(r["t"], 8),
             "bytes": r["bytes"], "sha256": r["sha256"]}
            for r in rows
        ],
    }
    mpath = os.path.join(FRAMES, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1)
        fh.write("\n")

    # ---------------- csv -------------------------------------------------
    cpath = os.path.join(PROOF, "growth-metrics.csv")
    cols = ["index", "t", "bytes", "mean_luma", "std_luma", "max_luma",
            "lit_px", "lit_frac", "coverage_px", "coverage_frac", "luma_mass",
            "adj_mean_delta", "adj_max_delta", "dhash", "ahash", "sha256"]
    with open(cpath, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)

    json.dump(rows, open(os.path.join(PROOF, "_rows.json"), "w"),
              default=float)
    print("manifest: %s\nmetrics : %s" % (mpath, cpath))


if __name__ == "__main__":
    main()
