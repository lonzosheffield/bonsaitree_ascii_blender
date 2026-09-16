#!/usr/bin/env python3
"""Build the M2 contact sheet from a preview frame directory.

    python tools/contact-sheet.py <frame-dir> <out.jpg> [--frames N] [--cols N]

One tile per frame_NNNN.png found, labelled with its normalised t and its frame
index, tiled left-to-right / top-to-bottom.  ffmpeg does all the work so there
is no image-library dependency; the label font is Consolas so the sheet reads in
the same monospace voice as the ASCII panel it sits beside.
"""
import argparse
import glob
import os
import re
import subprocess
import sys

FONT = "C:/Windows/Fonts/consola.ttf"
BAND = 34          # height of the label strip above each tile
BG = "0x0b0d10"    # matches the render's letterbox black


def esc(path):
    """Escape a Windows path for an ffmpeg filtergraph option value."""
    return path.replace(chr(92), "/").replace(":", chr(92) + ":")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frame_dir")
    ap.add_argument("out")
    ap.add_argument("--frames", type=int, default=600,
                    help="total frames in the sequence, for computing t")
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--width", type=int, default=1600, help="output width")
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.frame_dir, "frame_*.png")))
    if not paths:
        sys.exit("no frame_*.png in %s" % args.frame_dir)

    cols = args.cols
    rows = (len(paths) + cols - 1) // cols
    if rows * cols != len(paths):
        sys.exit("%d frames do not fill a %d-column grid" % (len(paths), cols))

    cmd = ["ffmpeg", "-y", "-v", "error"]
    for p in paths:
        cmd += ["-i", p]

    denom = float(max(args.frames - 1, 1))
    parts, labels = [], []
    for i, p in enumerate(paths):
        index = int(re.search(r"frame_(\d+)", os.path.basename(p)).group(1))
        text = "t=%.3f  (f%d)" % (index / denom, index)
        parts.append(
            "[%d:v]pad=iw:ih+%d:0:%d:color=%s,"
            "drawtext=fontfile='%s':text='%s':fontcolor=white:fontsize=22:"
            "x=(w-text_w)/2:y=6[v%d]"
            % (i, BAND, BAND, BG, esc(FONT), text, i))
        labels.append("[v%d]" % i)

    for r in range(rows):
        row = "".join(labels[r * cols:(r + 1) * cols])
        parts.append("%shstack=inputs=%d[r%d]" % (row, cols, r))
    parts.append("%svstack=inputs=%d,scale=%d:-2[out]"
                 % ("".join("[r%d]" % r for r in range(rows)), rows, args.width))

    cmd += ["-filter_complex", ";".join(parts),
            "-map", "[out]", "-frames:v", "1", "-q:v", "3", args.out]
    subprocess.run(cmd, check=True)
    print("contact sheet: %s  (%d frames, %dx%d grid)"
          % (args.out, len(paths), cols, rows))


if __name__ == "__main__":
    main()
