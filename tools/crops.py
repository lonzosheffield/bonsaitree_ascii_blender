#!/usr/bin/env python3
"""Cut the fixed look-gate inspection crops out of a 900x1200 frame directory.

    python tools/crops.py <frame-dir> [<out-dir>]

The camera is frozen (blender/bonsai_growth.py logs it every run), so a crop box
is a constant and the same box means the same piece of the tree on every frame
and in every round of the gate.  Boxes are in 900x1200 pixel coordinates;
`zoom` is the integer nearest-neighbour magnification, so 3x means one rendered
pixel becomes a 3x3 block and the grain of the bark is visible as it actually
is rather than as the resampler imagines it.

Named boxes, and why each one exists:
  base      the trunk / soil junction at the pot rim (v=0.90) — the M3 anchor,
            and where the round-2 gate found a flat lit end-cap face.
  left      the left primary branch, which arrives bare at t~0.45.
  apex      the apex crown, which closes a trapezoid around f109-f130.
  potseam   a wide, unzoomed strip across the whole pot and nebari.
"""
import argparse
import os
import subprocess
import sys

# name -> (x, y, w, h, zoom)
BOXES = {
    "base":    (300, 930, 320, 240, 3),
    "left":    (200, 740, 360, 300, 3),
    "apex":    (360, 600, 360, 300, 3),
    "potseam": (0, 900, 900, 300, 1),
}

# which boxes to cut from which frame index, when --all is not given
DEFAULT = {
    0:   ("base",),
    54:  ("base",),
    130: ("apex",),
    272: ("base", "left"),
    599: ("base", "potseam"),
}


def cut(src, dst, box):
    x, y, w, h, z = box
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src,
         "-vf", "crop=%d:%d:%d:%d,scale=%d:%d:flags=neighbor" % (w, h, x, y, w * z, h * z),
         "-frames:v", "1", dst],
        check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frame_dir")
    ap.add_argument("out_dir", nargs="?", default=None)
    ap.add_argument("--all", action="store_true",
                    help="cut every box from every frame present")
    args = ap.parse_args()
    out = args.out_dir or os.path.join(args.frame_dir, "crops")
    if not os.path.isdir(out):
        os.makedirs(out)

    made = 0
    for index, names in sorted(DEFAULT.items()):
        src = os.path.join(args.frame_dir, "frame_%04d.png" % index)
        if not os.path.isfile(src):
            continue
        for name in (BOXES if args.all else names):
            box = BOXES[name]
            dst = os.path.join(out, "f%04d-%s-%dx.png" % (index, name, box[4]))
            cut(src, dst, box)
            print("%s  <- frame_%04d  %s" % (os.path.basename(dst), index, box))
            made += 1
    if not made:
        sys.exit("no frames matched in %s" % args.frame_dir)


if __name__ == "__main__":
    main()
