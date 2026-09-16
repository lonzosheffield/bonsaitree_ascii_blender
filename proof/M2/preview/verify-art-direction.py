#!/usr/bin/env python3
"""M2 look-gate measurements.  Every number Fable named, plus the clean-plate
masking the new green ambient requires.

The t=0 frame is a CLEAN PLATE: fixed camera, empty pot, static backdrop.  So
"tree pixels" is not a colour test any more (the ambient is green now, and a
naive `G > R` test matches the backdrop glow); it is `this frame differs from
the plate`.  That is exact by construction.
"""
import glob, os, re, sys
import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722])
load = lambda p: np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
luma = lambda a: a @ LUMA

# right-pad box.  Fable's (x>0.68w, 0.50h..0.72h) was measured on the REJECTED
# framing (pot_rim_v 0.811, canopy_top_v 0.210, content u 0.024..0.976).  The
# new framing is pot_rim_v 0.900 / canopy_top_v 0.450 / content u 0.143..0.857,
# so the same piece of tree now lives here.  Both boxes are reported.
BOX_LITERAL = (0.50, 0.72, 0.68, 1.00)     # v0, v1, u0, u1
BOX_MAPPED  = (0.667, 0.832, 0.635, 1.00)
TRUNK_BOX   = (0.76, 0.90, 0.36, 0.56)

def region(a, box):
    h, w, _ = a.shape
    v0, v1, u0, u1 = box
    return a[int(v0*h):int(v1*h), int(u0*w):int(u1*w)]

def main(d, frames=600, label=""):
    paths = sorted(glob.glob(os.path.join(d, "frame_*.png")))
    idx = [int(re.search(r"frame_(\d+)", os.path.basename(p)).group(1)) for p in paths]
    imgs = {i: load(p) for i, p in zip(idx, paths)}
    keys = sorted(imgs)
    plate = imgs[keys[0]]
    h, w, _ = plate.shape
    denom = float(frames - 1)
    print("== %s%s  %d frames  %dx%d ==" % (label, d, len(paths), w, h))

    print("\n[1a] BOTTOM ROW / FLOOR BAND  (require bottom-row luma <= 9)")
    for i in keys:
        a = imgs[i]
        b1, b4 = a[h-1:h], a[h-4:h]
        print("   f%04d  row-1 RGB=(%4.1f,%4.1f,%4.1f) luma=%5.2f max=%5.1f | rows-4 luma=%5.2f"
              % (i, b1[...,0].mean(), b1[...,1].mean(), b1[...,2].mean(),
                 luma(b1).mean(), luma(b1).max(), luma(b4).mean()))

    print("\n[1b] CONTENT EXTENT at t=1, from the clean plate (delta luma > 6)")
    a = imgs[keys[-1]]
    m = (luma(a) - luma(plate)) > 6.0
    ys, xs = np.nonzero(m)
    print("   tree pixels span  u=%.4f..%.4f   v=%.4f..%.4f" %
          (xs.min()/w, (xs.max()+1)/w, ys.min()/h, (ys.max()+1)/h))
    print("   side margins: left=%.4f  right=%.4f   (require >= 0.12)"
          % (xs.min()/w, 1.0-(xs.max()+1)/w))
    green = m & (a[...,1] > a[...,0] + 3)
    gy, gx = np.nonzero(green)
    print("   leaf pixels span  u=%.4f..%.4f   v=%.4f..%.4f" %
          (gx.min()/w, (gx.max()+1)/w, gy.min()/h, (gy.max()+1)/h))

    print("\n[2] AMBIENT HUE at the first frame  (require G >= B and B-R <= +6)")
    for name, box in (("backdrop glow, behind canopy v=.42-.52 u=.35-.65", (0.42,0.52,0.35,0.65)),
                      ("backdrop glow, wide band     v=.30-.45 u=.10-.90", (0.30,0.45,0.10,0.90)),
                      ("backdrop peak row            v=.46-.50 u=.44-.56", (0.46,0.50,0.44,0.56)),
                      ("top rows                     v=.00-.06", (0.00,0.06,0.0,1.0)),
                      ("floor, left of pot           v=.90-.97 u=.05-.20", (0.90,0.97,0.05,0.20))):
        r = region(plate, box)
        print("   %-50s RGB=(%5.1f,%5.1f,%5.1f)  G-B=%+5.1f  B-R=%+5.1f"
              % (name, r[...,0].mean(), r[...,1].mean(), r[...,2].mean(),
                 r[...,1].mean()-r[...,2].mean(), r[...,2].mean()-r[...,0].mean()))

    print("\n[2b] TRUNK WARMTH  (wood only: differs from plate AND luma>40; require R-B >= +8)")
    for i in keys:
        a = imgs[i]
        box, pbox = region(a, TRUNK_BOX), region(plate, TRUNK_BOX)
        sel = ((luma(box) - luma(pbox)) > 8) & (luma(box) > 40)
        if sel.sum() < 30:
            print("   f%04d  (no wood in box yet: %d px)" % (i, sel.sum())); continue
        px = box[sel]
        print("   f%04d  lit=%5d  R=%6.2f G=%6.2f B=%6.2f   R-B=%+6.2f  R-G=%+6.2f"
              % (i, sel.sum(), px[...,0].mean(), px[...,1].mean(), px[...,2].mean(),
                 px[...,0].mean()-px[...,2].mean(), px[...,0].mean()-px[...,1].mean()))

    print("\n[3a] RIGHT-PAD LEAF PIXELS  (must strictly increase f109->f218->f327->f436->f490)")
    for bname, box in (("Fable's literal box (old framing)", BOX_LITERAL),
                       ("same pad, re-mapped to new framing", BOX_MAPPED)):
        print("   -- %s  v=%.3f..%.3f u=%.3f..%.3f" % (bname, box[0], box[1], box[2], box[3]))
        prev = None
        for i in keys:
            a = imgs[i]
            b, pb = region(a, box), region(plate, box)
            leafy = (((luma(b) - luma(pb)) > 6) & (b[...,1] > b[...,0] + 2)).sum()
            note = ""
            if prev is not None:
                note = ("  +%d" % (leafy-prev)) if leafy > prev else ("  *** NOT INCREASING (%+d)" % (leafy-prev))
            print("      f%04d  leaf px=%6d%s" % (i, leafy, note))
            prev = leafy

    print("\n[3b] WHOLE-FRAME mean|delta| between consecutive preview frames")
    print("     (BRIEF N7: any consecutive pair with t in [0.55,0.87] must be >= 0.80/255)")
    worst = None
    for a_i, b_i in zip(keys, keys[1:]):
        dd = np.abs(luma(imgs[b_i]) - luma(imgs[a_i])).mean()
        ta, tb = a_i/denom, b_i/denom
        gate = (0.55 <= tb <= 0.88) or (0.55 <= ta <= 0.88)
        tag = "  <-- N7 window" if gate else ""
        if gate and (worst is None or dd < worst):
            worst = dd
        print("   f%04d->f%04d  t=%.3f->%.3f  mean|d|=%6.3f/255%s" % (a_i, b_i, ta, tb, dd, tag))
    print("   worst pair inside the N7 window: %.3f/255  (need >= 0.80)" % (worst or 0))

    print("\n[4] LEAF SPECULAR GLITTER  (luma>200, B>R, blossoms masked out; require <= 150 at t=1)")
    for i in keys:
        a = imgs[i]
        hot = (luma(a) > 200) & (a[...,2] > a[...,0])
        pinkish = a[...,0] > a[...,1] - 25        # white / pink petal
        cool = hot & ~pinkish
        print("   f%04d  cool-highlight px=%5d   | all luma>200 px=%6d  of which petal-like=%6d"
              % (i, cool.sum(), (luma(a) > 200).sum(), (hot & pinkish).sum()))

    print("\n[4b] BRIGHTEST ELEMENTS IN THE CANOPY AT t=1")
    a = imgs[keys[-1]]
    can, cana = region(a, (0.40,0.88,0.0,1.0)), region(a, (0.40,0.88,0.0,1.0))
    cl = luma(can)
    petal = (cana[...,0] >= cana[...,1] - 10) & (cl > 90)
    leafy = (cana[...,1] > cana[...,0] + 3) & (cl > 90)
    for nm, msk in (("petal-like", petal), ("leaf-like ", leafy)):
        if msk.sum():
            print("   %s px=%6d  mean luma=%6.1f  p99=%6.1f  max=%6.1f"
                  % (nm, msk.sum(), cl[msk].mean(), np.percentile(cl[msk],99), cl[msk].max()))

if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 600,
         sys.argv[3] + " " if len(sys.argv) > 3 else "")
