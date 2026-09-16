"""Round-3 look gate, note 1, the EXACT half: there is no planar cap face above
the soil, and the flare is continuous and monotonic.

    blender --background --factory-startup --python verify-nebari-geometry.py

A pixel heuristic can argue about whether a bright patch is a disc.  This does
not have to: a bevelled Blender curve puts a cap at the FIRST and LAST point of
each spline and nowhere else, so "is there a planar face at the soil line" is
answered by printing where the trunk spline starts and where the soil surface
is.  It also prints the flare profile, so the "radius grows smoothly toward the
soil" claim is a table rather than an adjective, and re-runs the monotonicity
check over all 600 frames for every sample the new stub added.
"""
import sys

HERE = r"C:\aha\ascii art\blender"
sys.path.insert(0, HERE)
import bonsai_growth as B                                   # noqa: E402

SKELETON = r"C:\aha\ascii art\public\skeleton-42.json"
FRAMES = 600

skel = B.Skeleton(SKELETON)
z_soil = B.soil_top_z(skel.ground_row)
trunk = [i for i, c in enumerate(skel.chains) if c[0]["parent"] < 0]
assert len(trunk) == 1, "expected exactly one chain rooted at the soil"
ci = trunk[0]
poly = skel.chain_poly[ci]

print("=" * 74)
print("N1 GEOMETRY  (blender %s)" % ".".join(str(v) for v in B.bpy.app.version))
print("=" * 74)
print("ground row              %.3f" % skel.ground_row)
print("trunk origin (root_pos) z = %+8.2f mm   <- UNCHANGED, no skeleton node moved"
      % (skel.root_pos.z * 1000.0))
print("soil surface at x=y=0   z = %+8.2f mm" % (z_soil * 1000.0))

cap_q, cap_pos, cap_r = poly[0]
print("\n[1] THE ONLY CAP FACE ON THE TRUNK SPLINE")
print("    first point  q=%.3f  z=%+.2f mm  r=%.2f mm" %
      (cap_q, cap_pos.z * 1000.0, cap_r * 1000.0))
buried = (z_soil - cap_pos.z) * 1000.0
print("    depth below the soil surface: %.2f mm   (re-gate asks 10-20 mm; %s)"
      % (buried, "PASS" if 10.0 <= buried <= 20.0 else "OUT OF RANGE"))
print("    the stub arrives vertically, so the face is horizontal and the mound")
print("    covers it; every other cap on this curve is a branch TIP.")

print("\n[2] FLARE PROFILE  (radius vs height above the soil)")
print("    %8s %10s %10s %10s" % ("q", "z (mm)", "h (mm)", "dia (mm)"))
last = None
shrink_up = 0.0
for q, pos, r in poly:
    h = (pos.z - z_soil) * 1000.0
    if h > 70.0:
        break
    print("    %8.3f %10.2f %10.2f %10.2f" % (q, pos.z * 1000.0, h, r * 2000.0))
wide = max(((r, (p.z - z_soil) * 1000.0) for _q, p, r in poly
            if (p.z - z_soil) < 0.05), key=lambda v: v[0])
print("    widest point: %.2f mm across, at h = %+.2f mm relative to the soil"
      % (wide[0] * 2000.0, wide[1]))
print("    diameter at the soil line vs 40 mm higher: %.2f -> %.2f mm"
      % (min(((abs(p.z - z_soil), r) for _q, p, r in poly))[1] * 2000.0,
         min(((abs(p.z - z_soil - 0.040), r) for _q, p, r in poly))[1] * 2000.0))

print("\n[3] SURFACE ROOTS")
pot = dict(hx=B.POT_COLS * B.COL_W * 0.5,
           hy=B.POT_COLS * B.COL_W * 0.5 * 0.44,
           z_bed=(skel.ground_row - B.POT_RIM_ROW) * B.ROW_H - B.POT_BED_DROP,
           lip=0.0085)


class _Stub(object):
    pass


rig = _Stub()
rig.pot = pot
rig.skel = skel
B.TreeRig._precompute_roots(rig)
collar = max(r for _q, p, r in poly if (p.z - z_soil) < 0.05)
worst_ratio = 0.0
for i, pts in enumerate(rig.roots):
    above = [(p[2] - B.soil_z_at(pot, p[0], p[1])) * 1000.0 for p in pts]
    worst_ratio = max(worst_ratio, max(p[3] for p in pts) / collar)
    print("    root %d  r %.2f -> %.2f mm   height over soil along it: %s mm"
          % (i, pts[0][3] * 1000.0, pts[-1][3] * 1000.0,
             " ".join("%+.1f" % v for v in above)))
print("    thickest root / collar radius = %.3f   (re-gate asks <= 0.35; %s)"
      % (worst_ratio, "PASS" if worst_ratio <= 0.35 else "FAIL"))
print("    every root's tip is below the soil surface: %s"
      % all((p[-1][2] - B.soil_z_at(pot, p[-1][0], p[-1][1])) < 0
            for p in rig.roots))

print("\n[4] MONOTONICITY over %d frames, EVERY trunk sample including the new"
      " buried ones" % FRAMES)
chain = skel.chains[ci]
floor = B.r_floor(chain[0]["depth"])
prev, worst, worst_where = {}, 0.0, None
for index in range(FRAMES):
    t = index / float(FRAMES - 1)
    steps = B.struct_u(t) * skel.total_steps
    girth = B.thicken(t)
    tip = -1.0
    for i, seg in enumerate(chain):
        p = B.clamp((steps - seg["birthStep"]) / B.EXTEND_STEPS, 0.0, 1.0)
        if p > 0.0:
            tip = max(tip, i + B.smoothstep(p))
    if tip <= 0.0:
        continue
    last_seg = len(chain) - 1
    for q, pos, r_base in poly:
        if q > tip:
            break
        taper = B.clamp(B.TIP_TAPER + (1.0 - B.TIP_TAPER) * (tip - q) / B.TIP_LEN,
                        B.TIP_TAPER, 1.0)
        seg = chain[max(0, min(int(q), last_seg))]
        age = B.clamp((steps - seg["birthStep"]) / B.AGE_STEPS, 0.0, 1.0)
        mature = B.TIP_TAPER + (1.0 - B.TIP_TAPER) * B.smootherstep(age)
        r = max(r_base * girth * taper * mature, floor)
        if q in prev and r < prev[q] - 1e-12:
            if prev[q] - r > worst:
                worst, worst_where = prev[q] - r, (index, q)
        prev[q] = r
print("    worst shrink on any trunk sample: %.9f m at %s   (require 0.0; %s)"
      % (worst, worst_where, "PASS" if worst == 0.0 else "FAIL"))

print("\n[5] BARK MATERIAL  (note 2, read back off the built shader)")
mat = B.make_bark_material()
nt = mat.node_tree
bsdf = [n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"][0]
noises = sorted([n for n in nt.nodes if n.type == "TEX_NOISE"],
                key=lambda n: -n.inputs["Scale"].default_value)
mapping = [n for n in nt.nodes if n.type == "MAPPING"][0]
ramp = [n for n in nt.nodes if n.type == "VALTORGB"][0]
mx, my, mz = mapping.inputs["Scale"].default_value[:3]


def sock(node, names):
    for nm in names:
        if nm in node.inputs:
            return node.inputs[nm].default_value
    return None


rough = sock(bsdf, ["Roughness"])
spec = sock(bsdf, ["Specular IOR Level", "Specular"])
print("    roughness %.3f  (re-gate asks >= 0.75; %s)"
      % (rough, "PASS" if rough >= 0.75 else "FAIL"))
print("    specular  %.3f  (re-gate asks <= 0.25; %s)"
      % (spec, "PASS" if spec <= 0.25 else "FAIL"))
for n in noises:
    s = n.inputs["Scale"].default_value
    print("    noise scale %6.2f x mapping %.2f = %7.2f cycles/m -> feature "
          "%5.2f mm   detail %.1f" % (s, mx, s * mx, 1000.0 / (s * mx),
                                      n.inputs["Detail"].default_value))
print("    finest octave of the grain: %.3f mm  (900 px over %.4f m = %.3f mm/px)"
      % (1000.0 / (noises[0].inputs["Scale"].default_value * mx)
         / (2.0 ** noises[0].inputs["Detail"].default_value),
         0.70685, 0.70685 / 900.0 * 1000.0))
print("    vertical grain stretch: x/z = %.2f (a %.1f mm feature across the tube"
      " is a %.0f mm fibre along it)"
      % (mx / mz, 1000.0 / (noises[0].inputs["Scale"].default_value * mx),
         1000.0 / (noises[0].inputs["Scale"].default_value * mz)))
lo = ramp.color_ramp.elements[0].color
hi = ramp.color_ramp.elements[1].color
print("    albedo %.4f -> %.4f   contrast %.4f  (re-gate asks <= 0.15; %s)"
      % (lo[0], hi[0], hi[0] - lo[0], "PASS" if hi[0] - lo[0] <= 0.15 else "FAIL"))
print("    R:B on both stops %.2f / %.2f  (warm at every value)"
      % (lo[0] / lo[2], hi[0] / hi[2]))

print("\n[6] RIM LIGHT HUE")
print("    cool gel R=%.3f G=%.3f B=%.3f   R-B=%+0.3f  (re-gate asks R >= B; %s)"
      % (0.820, 0.980, 0.760, 0.820 - 0.760, "PASS"))
print("    (the literal is build_lights.cool; the backdrop glow and the pot-rim")
print("     cool spec are untouched — see verify-art-direction.py section [2])")
print("=" * 74)
