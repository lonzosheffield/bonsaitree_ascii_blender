import sys
sys.path.insert(0, r"C:\aha\ascii art\blender")
import bonsai_growth as B
skel = B.Skeleton(r"C:\aha\ascii art\public\skeleton-42.json")
F = 600

def state(index):
    t = index / float(F - 1)
    steps = B.struct_u(t) * skel.total_steps
    return t, steps, B.thicken(t)

def chain_max_r(ci, index, old=False):
    t, steps, girth = state(index)
    chain = skel.chains[ci]
    tip = -1.0
    for i, seg in enumerate(chain):
        p = B.clamp((steps - seg["birthStep"]) / B.EXTEND_STEPS, 0.0, 1.0)
        if p > 0.0:
            tip = max(tip, i + B.smoothstep(p))
    if tip <= 0.0:
        return None
    last = len(chain) - 1
    best = 0.0
    for q, pos, r_base in skel.chain_poly[ci]:
        if q > tip:
            break
        taper = B.clamp(B.TIP_TAPER + (1.0 - B.TIP_TAPER) * (tip - q) / B.TIP_LEN,
                        B.TIP_TAPER, 1.0)
        m = 1.0
        if not old:
            seg = chain[min(int(q), last)]
            age = B.clamp((steps - seg["birthStep"]) / B.AGE_STEPS, 0.0, 1.0)
            m = B.TIP_TAPER + (1.0 - B.TIP_TAPER) * B.smootherstep(age)
        best = max(best, max(r_base * girth * taper * m, B.R_MIN))
    return best

# f247..f262 -> skeleton steps
for f in (247, 262):
    print("frame %d -> t=%.4f steps=%.1f" % (f, state(f)[0], state(f)[1]))

cands = [(ci, c[0]["birthStep"],
          min(p[1].x for p in skel.chain_poly[ci]),
          len(c))
         for ci, c in enumerate(skel.chains)
         if 225 <= c[0]["birthStep"] <= 252]
cands.sort(key=lambda r: r[2])
print("\nchains born in skeleton steps 225-252 (the f247-f262 window):")
for ci, b, mx, n in cands:
    print("  chain %3d birthStep=%3d  minX=%+.4f m  segs=%d" % (ci, b, mx, n))

target = cands[0][0]   # furthest to camera-left
print("\n=== chain %d (furthest camera-left, birthStep=%d) ===" % (target, cands[0][1]))
final_new = chain_max_r(target, 599)
print("%6s %7s %11s %11s %9s %9s %9s" %
      ("frame", "t", "NEW r_mm", "OLD r_mm", "NEW %fin", "OLD %fin", "trunk_mm"))
for f in (244, 247, 250, 255, 258, 262, 270, 280, 295, 312, 340, 400, 599):
    rn = chain_max_r(target, f)
    ro = chain_max_r(target, f, old=True)
    tr = chain_max_r(0, f)
    if rn is None:
        print("%6d %7.4f    (not born)" % (f, state(f)[0]))
        continue
    print("%6d %7.4f %11.3f %11.3f %8.0f%% %8.0f%% %9.2f"
          % (f, state(f)[0], rn * 1000, ro * 1000,
             100 * rn / final_new, 100 * ro / final_new, tr * 1000))
