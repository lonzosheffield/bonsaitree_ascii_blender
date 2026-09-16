# Bonsai Duet — Retrospective

A closeout on how this got built: what held up, what didn't, and what I'd do
differently. Written to be useful to whoever runs the next build like this,
including future me.

**What shipped:** two panels on one clock. A JavaScript port of cbonsai that is
byte-identical to the real C program, beside a 600-frame Blender render of the
*same tree* — both lofted from one seeded skeleton. Seed to full bloom over an
hour, then it stops.

**What it cost:** 33 agents across 4 workflows, ~3.9M subagent tokens, 1,611 tool
calls, ~9.7 hours wall clock. Five QA gates. One near-miss that would have cost
50 minutes of GPU and produced something unwatchable.

---

## What worked

### 1. The user's corrections were specification-grade, and arrived before any code

Four technical objections came back with the initial plan. All four were correct:

| Correction | What it prevented |
|---|---|
| VP9's default keyframe spacing breaks `currentTime` seeking | A sync gate failing for reasons unrelated to growth. Became N4: the JPEG ladder is primary, video is decorative |
| 120 frames over an hour reads as a slideshow | Became N5: 600 frames with browser-side crossfade |
| glibc's `rand()` is TYPE_3 additive feedback, not a generic PRNG | A build agent reaching for Mersenne Twister and producing a different tree entirely |
| cbonsai's shape is a function of terminal dimensions | A golden capture at the wrong size, making every diff meaningless |

The cheapest possible moment to absorb a correction is before the first line of
code. Each of these would have been a multi-hour debugging session later.

### 2. Writing the contract to a file, not a prompt

`docs/BRIEF.md` started as six non-negotiables and grew to 232 lines. Every agent
read it first. Every gate judged against it. Findings were appended as numbered
constraints *with the reasoning and the specific wrong turn they prevent*, so a
later agent couldn't quietly undo them.

This mattered more than expected. Prompts are per-agent and vanish; a brief is
durable and shared. When the M2 agent needed to know why it must not parallelize
the render, the measurement was right there with the number attached.

### 3. Fable re-derived instead of reading reports

The single highest-value property of the whole setup. Examples of what a
report-reading reviewer would have missed:

- **Recompiled the glibc golden vectors in a fresh container** rather than
  trusting the committed ones, then matched 800,000 values across 8 seeds.
- **Instrumented the real cbonsai binary** to log every `rand()` call to stderr,
  proving call *order* matched — 733 calls for seed 1, 1965 for seed 42,
  identical value for value. I had asked only that the port be reviewed.
- **Recomputed all 600 frame checksums** when the criterion said "at least 20".
- **Proved the render was sequential via file mtimes** — gaps of 3.8–10.6s
  against the known ~29s/frame signature of parallel contention.
- **Checked `soak-runner.mjs` for a `Date` override** before believing the
  elapsed time, then cross-checked that five screenshot mtimes sat exactly 15
  minutes apart.

### 4. A cheap gate in front of an expensive one

An art-direction review on a 12-frame preview at 450×600 ran before committing
~60 minutes of GPU. It paid for itself immediately, and in a way a sparse preview
structurally could not have: Fable **rendered its own dense 37-frame window** to
watch a branch being born, and found branches emerging at near-final girth
("a real shoot is thin for minutes and fattens; this one is toothpaste"). Frames
six minutes apart can never show a birth moment.

### 5. Measuring the obvious thing before assuming it

The instinct on a 14-core machine is to chunk a 600-frame render across
processes. Measured: **3 concurrent Blender processes rendered at 29.1s/frame
each versus 4.9s solo** — the integrated GPU is saturated by one EEVEE process,
so 3× the concurrency bought a ~2× throughput *loss*. That went in the brief with
the numbers, and the later gate used the same figure as a forensic signature.

### 6. One skeleton, two media

Instead of re-porting cbonsai's algorithm to Python for Blender, the already
gate-verified JS port exports its branch walk as JSON and Blender lofts geometry
from those exact segments. Single source of truth, no second fidelity problem.

It also paid an unplanned dividend: because the skeleton carries `birthStep`, the
fix for toothpaste branches (age-ramped girth) was *possible*. A design choice
made for sync turned out to be what enabled realistic wood aging.

### 7. Treating a dead QA agent as a non-verdict

The first M0 gate agent died to a `529 Overloaded`. The guard re-ran the gate
rather than dispatching a remediation round, so an infrastructure blip didn't
consume fix budget or get mistaken for a pass. Small detail, would have been
genuinely confusing.

---

## What didn't work

### 1. I capped the art-direction loop at one revision — and made it render anyway

The worst call in the build, and it was mine, not an agent's. The fallback logged
"proceeding to render anyway so M2 produces something Fable can gate on." That
reasoning is backwards: the entire purpose of a cheap gate before an expensive
one is to *not* spend the expensive resource on rejected work.

Caught it with 0 frames rendered. Raised the cap to 4 and changed the terminal
behaviour to **abort rather than render**. Art direction then converged on
**pass 4 of 4** — verdicts ran `FAIL → FAIL → FAIL → FAIL → PASS`.

With the original cap, the shipped artifact would have been the blue,
statically-frozen, wire-branched version still preserved under
`proof/M2/preview/superseded-*-build/`.

**Lesson:** loop caps should be set by how long convergence plausibly takes, not
by fear of infinite loops. And "produce something to gate on" is never worth more
than "don't burn the expensive resource."

### 2. I estimated render time from a probe scene, not the real rig

An early probe measured 4.9s/frame — on a lit sphere and 40 cubes. The finished
bonsai ran 6.8–7.2s/frame. The estimate was off by ~40% because the thing I
measured wasn't the thing I was estimating.

Fable caught it and flagged the risk that an agent would silently downscale to
720×960 to hit a stale deadline. Recorded the real number as accepted and made
silent downscaling an explicit gate failure.

### 3. Three assumptions about cbonsai that were wrong

All three would have surfaced as confusing failures much later:

- **`cbonsai -p` does not emit clean text.** It runs the whole ncurses
  animation, calls `endwin()`, *then* dumps the grid — and decorates every
  individual cell with SGR codes. A naive diff compares ~3526 columns of escape
  soup.
- **It emits malformed `ESC[3-1m`** when fg is −1, because line 747 formats `-1`
  into `\033[3%him`. The obvious strip regex `\033\[[0-9;]*m` silently misses it,
  leaving `[3-1m` embedded in the "stripped" grid.
- **The tree window is 36 rows, not 40.** The bottom 4 belong to base art. Since
  branch length is a function of *window* size, a 40-row port produces a wrongly
  proportioned tree.

### 4. "Monotonic" gates passed a still image

Every gate through M2's first look review checked that growth never went
backwards. It never did. It also barely went *forwards*: the right branch reached
full length by t=0.067 and then changed by **0.19–0.39 luma across 110-frame
steps**. The right third of the picture did nothing for ~55 of the 60 minutes.

The root cause is honest and structural: **cbonsai's growth is inherently
front-loaded and discrete.** Branches snap into existence and never change. Over
a few seconds in a terminal that's invisible; over an hour it's fatal. And the
ASCII panel can't fix it, because its timing *is* the skeleton and the skeleton
is the sync contract.

The resolution had to be asymmetric — the Blender panel carries the continuity
the character grid structurally cannot (leaf size, leaf count, leaf colour,
girth), all of which were switched off at birth. `THICKEN_GAMMA=0.60` was
delivering 83% of final girth by the halfway mark, exactly backwards.

**Lesson, now N7 in the brief:** *monotonic is necessary but not sufficient. A
still image is perfectly monotonic.* Liveness needs its own measured test —
consecutive frames in t ∈ [0.55, 0.87] must differ by ≥ 0.8/255.

### 5. The README described a repository that didn't exist

It told readers the frames were "committed", "in the repository", and to
"re-clone" if they were missing — while git had **zero commits and zero tracked
files**. Fable caught it at the final gate.

Then, while fixing it, I referenced `tools/verify-frames.mjs` — which did not
exist. I committed the same class of error inside the fix for it. Caught on the
next check and wrote the tool (Node-only, so it honours the README's own
"Node is all you need" promise; verifies 600 checksums in 1.0s).

**Lesson:** documentation claims are assertions about the world and deserve the
same verification as code. "Follow the README literally from cold, as a stranger"
should be a gate criterion from the start, not only at the end.

### 6. Environment discoveries arrived later than they should have

Three surprises that a 10-minute upfront audit would have surfaced:

- Port 8080 permanently held by an unrelated `family-hub` process (moved to 8137)
- Blender's exe unreachable from Git Bash — "Permission denied"; PowerShell only
- **The SSH key is a read-only deploy key for a different repo**, discovered only
  at push time

The last one is the sharpest: it will block SSH pushes from this machine to *any*
repository, and nothing about the build would ever have revealed it.

### 7. Line endings nearly broke the proof

At `git add` time, Git was about to normalize `proof/M1/golden/**` — the
byte-exact cbonsai captures the fidelity diff compares against. A CRLF conversion
on checkout would have made the verification quietly meaningless for anyone who
cloned. Fixed with `.gitattributes` marking them `-text`. Should have been set up
with `git init`, not discovered at staging.

---

## The pattern worth carrying forward

The most expensive bugs in this build shared one property: **they present as a
different bug.**

| Actual cause | What it looks like |
|---|---|
| Wrong PRNG family | A branching algorithm bug |
| Correct PRNG, wrong call order | A branching algorithm bug |
| 40-row window instead of 36 | A bad `setDeltas` port |
| Raw capture vs stripped grid | A broken port |
| Front-loaded growth curve | Nothing at all — every check passes |

Each sends you to the wrong file. That's the category that eats days, and it's
the entire justification for the cost of proof-based gates. A reviewer that reads
reports finds none of them; a reviewer that re-derives finds all of them.

The corollary: **gates must test the property you actually care about, not a
proxy for it.** Four gates checked monotonicity — the proxy — and passed a
picture that wasn't moving.

---

## If I ran this again

1. **Audit the environment first.** Ports, toolchain reachability, git identity,
   push credentials. Ten minutes; would have caught three of the surprises above.
2. **Set `.gitattributes` at `git init`**, before any byte-exact artifact exists.
3. **Put a liveness criterion in the brief from day one**, not just monotonicity.
4. **Size loop caps by expected convergence.** Four passes was barely enough;
   one would have shipped the wrong artifact.
5. **Probe with the real workload**, not a stand-in, before quoting a budget.
6. **Make "follow the docs from cold" an early gate**, not a final one.
7. **Keep the cheap-gate-before-expensive-gate pattern.** It was the highest
   leverage structural decision in the build.
