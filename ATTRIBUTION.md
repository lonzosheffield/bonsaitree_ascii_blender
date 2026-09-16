# Attribution and licensing

## cbonsai — GPL-3.0

The left-hand panel is a JavaScript port of **cbonsai** by John Allbritten:
<https://gitlab.com/jallbrit/cbonsai>

cbonsai is licensed **GNU GPL v3.0**. Its full source is vendored unmodified at
`vendor/cbonsai/` (including its `LICENSE`) because the port was verified
line-by-line against it, and because the build diffs our output against the real
binary's output.

These files are **derivative works** of cbonsai and carry its GPL-3.0 terms:

| File | Relationship to cbonsai |
|---|---|
| `src/ascii/bonsai.js` | Direct port of the growth algorithm — `branch()`, `setDeltas()`, `chooseColor()`, `chooseString()`, base art, leaf strings |
| `src/ascii/terminal.js` | Reimplements cbonsai's palette and cell rendering |
| `src/shared/glibc-rand.js` | Not derived from cbonsai. Implements glibc's `random()` TYPE_3 generator so that `srand(seed)` + `rand()` reproduce byte-identically |
| `public/skeleton-*.json` | Generated output of the ported algorithm |

Because the Blender rig builds its geometry from `skeleton-*.json`, the rendered
frames in `public/frames/` are downstream of cbonsai's algorithm as well.

## No project licence has been chosen yet

**This is a decision for the repository owner, not something the build made.**

Given that the ASCII panel is a direct port of GPL-3.0 code, the conservative and
most likely correct choice is to license this project **GPL-3.0** as well. To do
that, copy `vendor/cbonsai/LICENSE` to `./LICENSE` and add a copyright line.

If you intend a different licence, get advice first — a faithful algorithmic port
is generally treated as a derivative work, and that constrains the options.

## Everything else

The Blender rig (`blender/bonsai_growth.py`), the clock, the frame-ladder
scrubber, the server, the tooling under `tools/`, and the QA evidence under
`proof/` are original to this project and are not derived from cbonsai.
