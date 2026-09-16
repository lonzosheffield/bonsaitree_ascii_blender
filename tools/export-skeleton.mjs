#!/usr/bin/env node
/**
 * export-skeleton.mjs — export the cbonsai branch structure as JSON so the
 * Blender rig and the ASCII panel are literally the same tree.
 *
 * ============================================================================
 * THE ONE RULE: THIS FILE DOES NOT CONTAIN THE GROWTH ALGORITHM.
 * ============================================================================
 *
 * `src/ascii/bonsai.js` and `src/shared/glibc-rand.js` passed the M1 gate and
 * are frozen. Nothing here re-derives a branch position, a dice roll, or a
 * delta. This tool *imports* them, runs the real walk, and OBSERVES it.
 *
 * How the observation works, and why it is exact rather than a guess:
 *
 *   `branch()` (bonsai.js) is a recursive function whose every decision is a
 *   `rng.rand()` call. We temporarily wrap `GlibcRandom.prototype.rand` — a
 *   runtime monkey-patch, no file on disk is touched — and capture a V8
 *   structured stack trace on every draw. A stack trace gives us, for free:
 *
 *     * the FUNCTION the draw came from (`setDeltas`, `chooseColor`,
 *       `chooseString`, `branch` itself), and
 *     * the exact SOURCE LINE of the call site in every frame, and
 *     * the full chain of nested `branch` frames, i.e. the live recursion
 *       stack of the tree being grown.
 *
 *   Those line numbers are not incidental — each one is a distinct arm of
 *   cbonsai's own switch statements, so they identify the branch type, the
 *   life band, the spawn kind and the iteration boundary without any
 *   re-implementation. They are resolved by SEARCHING the frozen source for
 *   unique marker strings (see `locateCallSites`), so this tool fails loudly
 *   if bonsai.js ever changes shape instead of silently exporting nonsense.
 *
 *   Geometry comes from the frozen walk's own write log: `growth.steps[i]` is
 *   the list of cells cbonsai's `updateScreen()` would have shown after
 *   iteration `i`, and `steps[i][0]` is the `mvwprintw()` anchor — that is,
 *   the (y, x) the branch moved to. We read positions; we never compute them.
 *
 * ----------------------------------------------------------------------------
 * COORDINATE SPACE (BRIEF N2 + the N2 addendum)
 * ----------------------------------------------------------------------------
 * The terminal (stdscr) is 80 cols x 40 rows. `drawBase()` steals the bottom
 * 4 rows for the pot, so the ncurses `treeWin` is 80 cols x **36 rows** with
 * its origin at stdscr (0, 0) — `begY = 0, begX = 0`. cbonsai self-reports
 * `maxX: 080 / maxY: 036` for exactly this reason.
 *
 * Because treeWin's origin IS stdscr's origin, the mapping is the identity on
 * the rows the tree can reach:
 *
 *     skeleton y = 0   ->  terminal row 0   (top of the screen)
 *     skeleton y = 35  ->  terminal row 35  (the ground line the trunk sits on)
 *     terminal rows 36..39                  (base art; no tree cell ever lands there)
 *     skeleton x = 0..79 -> terminal col 0..79   (identity)
 *
 * The trunk is seeded at `branch(ctx, treeRows - 1, floor(cols / 2), ...)`
 * (bonsai.js), i.e. **y = 35, x = 40** — the "(35, 40)" of the N2 addendum,
 * written (row, col). In this file's `{x, y}` fields that is `x = 40, y = 35`.
 * y increases DOWNWARD: y = 0 is the top, y = 35 is the ground. A Blender rig
 * wanting a Z-up world should use `z = (35 - y)` and `X = (x - 40)`.
 *
 * ----------------------------------------------------------------------------
 * WHAT A "SEGMENT" IS
 * ----------------------------------------------------------------------------
 * One segment == one iteration of `branch()`'s while loop == one cbonsai
 * animation step == one entry in `growth.steps`. It is the short stroke from
 * where the branch was, `(x0, y0)`, to where it moved to, `(x1, y1)`, drawn
 * with one branch string. So `segments[i].birthStep` is unique and dense in
 * `[0, totalSteps)`, and the segment list in `birthStep` order IS the growth
 * animation.
 *
 *   * `parent` is the previous segment of the same branch, or — for the first
 *     segment of a branch — the segment of the PARENT branch that it forked
 *     from. The root trunk's first segment has `parent: -1`.
 *   * `depth` is recursion depth: the root trunk is 0, its children 1, ...
 *   * `life` is cbonsai's remaining life at that iteration (after the `life--`
 *     at the top of the loop) and `age` is `maxLife - life`, exactly as
 *     `branch()` computes them.
 *
 * A step whose glyph came from the leaf list also produces an entry in
 * `leaves`, positioned at that segment's `(x1, y1)` and carrying the same
 * `birthStep`. Leaves are therefore a strict subset of steps, not extra ones:
 * the ASCII panel and Blender reach the same stage at the same `t`.
 *
 * ----------------------------------------------------------------------------
 * VERIFICATION
 * ----------------------------------------------------------------------------
 * `--verify` rebuilds the full 80x40 character grid from the exported JSON
 * alone (plus cbonsai's static pot art, which is furniture, not growth) and
 * diffs it against `proof/M1/golden/seed-<n>.plain.txt`. If the skeleton were
 * missing a segment, mis-ordered a birthStep, or dropped a leaf, the diff
 * would not be clean. That reconstruction deliberately re-derives each glyph
 * from `(type, life, dx, dy)` rather than storing it, so the test measures the
 * skeleton's completeness instead of trivially echoing a cached string.
 *
 * Usage:
 *   node tools/export-skeleton.mjs                       # seeds 42,1337 + verify
 *   node tools/export-skeleton.mjs --seeds 42,1337,7
 *   node tools/export-skeleton.mjs --no-verify
 *   node tools/export-skeleton.mjs --out public --proof proof/M2/skeleton-roundtrip.txt
 *
 * @module tools/export-skeleton
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GlibcRandom } from '../src/shared/glibc-rand.js';
import {
	BASE_ART,
	BranchType,
	ColorPair,
	DEFAULT_COLS,
	DEFAULT_ROWS,
	growBonsai,
	wcwidth,
} from '../src/ascii/bonsai.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BONSAI_SRC = resolve(ROOT, 'src/ascii/bonsai.js');
const RAND_SRC = resolve(ROOT, 'src/shared/glibc-rand.js');

/** Name of each {@link BranchType}, for the exported `type` field. */
const TYPE_NAME = Object.freeze(['trunk', 'shootLeft', 'shootRight', 'dying', 'dead']);

// ---------------------------------------------------------------------------
// Call-site resolution
// ---------------------------------------------------------------------------

/**
 * Every `rand()` call site in the frozen source that we need to recognise,
 * keyed by a marker string that must appear EXACTLY once (or, where noted,
 * exactly twice) in `src/ascii/bonsai.js`.
 *
 * Using markers rather than hard-coded line numbers means a reformat of the
 * frozen file is detected and reported instead of silently shifting every
 * classification by a line.
 *
 * @type {Readonly<Record<string, {marker: string, count?: number}>>}
 */
const MARKERS = Object.freeze({
	// --- the setDeltas() call, one per growth iteration ---------------------
	SETDELTAS_CALL: { marker: 'const d = setDeltas(rng, type, life, age, multiplier);' },

	// --- draws inside setDeltas(): each arm names its branch type -----------
	SD_TRUNK_NEW: { marker: 'dx = (rng.rand() % 3) - 1; // cbonsai.c:299' },
	SD_TRUNK_YOUNG: { marker: 'dice = roll(rng, 10); // cbonsai.c:308' },
	SD_TRUNK_MID_DY: { marker: 'dice = roll(rng, 10); // cbonsai.c:317' },
	SD_TRUNK_MID_DX: { marker: 'dx = (rng.rand() % 3) - 1; // cbonsai.c:320' },
	SD_SHOOTL_DY: { marker: 'dice = roll(rng, 10); // cbonsai.c:325' },
	SD_SHOOTL_DX: { marker: 'dice = roll(rng, 10); // cbonsai.c:330' },
	SD_SHOOTR_DY: { marker: 'dice = roll(rng, 10); // cbonsai.c:338' },
	SD_SHOOTR_DX: { marker: 'dice = roll(rng, 10); // cbonsai.c:343' },
	SD_DYING_DY: { marker: 'dice = roll(rng, 10); // cbonsai.c:351' },
	SD_DYING_DX: { marker: 'dice = roll(rng, 15); // cbonsai.c:356' },
	SD_DEAD_DY: { marker: 'dice = roll(rng, 10); // cbonsai.c:367' },
	SD_DEAD_DX: { marker: 'dx = (rng.rand() % 3) - 1; // cbonsai.c:371' },

	// --- draws inside chooseColor(): an independent read of the type --------
	CC_WOOD: { marker: 'if (rng.rand() % 2 === 0) return { pair: ColorPair.woodBright, bold: true };' },
	CC_DYING: { marker: 'if (rng.rand() % 10 === 0) return { pair: ColorPair.leafBright, bold: true };' },
	CC_DEAD: { marker: 'if (rng.rand() % 3 === 0) return { pair: ColorPair.leafDark, bold: true };' },

	// --- the leaf draw inside chooseString() --------------------------------
	CS_LEAF: { marker: 'return leaves[rng.rand() % leaves.length]; // cbonsai.c:412' },

	// --- calls made once per iteration, in branch() -------------------------
	BR_COLOR: { marker: 'const color = chooseColor(rng, type); // cbonsai.c:491' },
	BR_STRING: {
		marker: 'const branchStr = chooseString(rng, conf.leaves, type, life, dx, dy); // cbonsai.c:494',
	},

	// --- recursive spawn sites, and the draws that guard them ---------------
	BR_SPAWN_DEAD: { marker: 'branch(ctx, y, x, BranchType.dead, life);' },
	BR_SPAWN_DYING: { marker: 'branch(ctx, y, x, BranchType.dying, life);', count: 2 },
	BR_REBRANCH_TEST: { marker: '(rng.rand() % 3 === 0 || life % multiplier === 0)' },
	BR_TRUNK_TEST: { marker: 'if (rng.rand() % 8 === 0 && life > 7) {' },
	BR_SPAWN_TRUNK: {
		marker: 'branch(ctx, y, x, BranchType.trunk, life + ((rng.rand() % 5) - 2));',
	},
	BR_SPAWN_SHOOT: {
		marker: 'branch(ctx, y, x, (ctx.counters.shootCounter % 2) + 1, shootLife);',
	},

	// --- the root call, in growBonsai() -------------------------------------
	ROOT_SPAWN: {
		marker: 'branch(ctx, treeRows - 1, Math.floor(cols / 2), BranchType.trunk, conf.lifeStart);',
	},
});

/**
 * Find the 1-based line number of every marker in the frozen source.
 *
 * @param {string} source The text of `src/ascii/bonsai.js`.
 * @returns {Record<string, number|number[]>} Marker name -> line (or lines).
 * @throws {Error} If a marker is missing or does not appear the expected number
 *   of times, which means bonsai.js no longer matches what this tool observes.
 */
function locateCallSites(source) {
	const lines = source.split('\n');
	/** @type {Record<string, number|number[]>} */
	const at = {};
	for (const [name, spec] of Object.entries(MARKERS)) {
		const hits = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(spec.marker)) hits.push(i + 1);
		}
		const want = spec.count === undefined ? 1 : spec.count;
		if (hits.length !== want) {
			throw new Error(
				`export-skeleton: expected ${want} occurrence(s) of the ${name} marker in ` +
					`src/ascii/bonsai.js but found ${hits.length}. The frozen source has changed ` +
					`shape; re-check the markers in MARKERS before trusting any skeleton.\n` +
					`  marker: ${spec.marker}`,
			);
		}
		at[name] = want === 1 ? hits[0] : hits;
	}
	return at;
}

// ---------------------------------------------------------------------------
// Stack capture
// ---------------------------------------------------------------------------

/**
 * One observed `rand()` draw: its value, and the bonsai.js frames that led to
 * it (innermost first) as `{fn, line}`.
 *
 * @typedef {object} RandEvent
 * @property {number} value What `rand()` returned.
 * @property {{fn: string, line: number}[]} frames bonsai.js frames, innermost first.
 */

/**
 * Run the frozen `growBonsai()` while recording the call stack of every
 * `rand()` draw.
 *
 * The patch is installed on `GlibcRandom.prototype` and removed in a `finally`
 * so the module is left exactly as it was found. Draws made before
 * `growBonsai()` is entered (glibc's 310-output warm-up) and the single
 * `shootCounter` seed draw carry no `branch` frame and are ignored downstream.
 *
 * @param {object} options Options forwarded verbatim to `growBonsai`.
 * @returns {{growth: import('../src/ascii/bonsai.js').BonsaiGrowth, events: RandEvent[]}}
 */
function growObserved(options) {
	const original = GlibcRandom.prototype.rand;
	const prevLimit = Error.stackTraceLimit;
	/** @type {RandEvent[]} */
	const events = [];
	let recording = false;

	// Infinity, not a number: branch() recursion plus roll()/setDeltas() frames
	// can exceed V8's default 10, and a truncated stack would hide the very
	// frames that identify the branch.
	Error.stackTraceLimit = Infinity;

	GlibcRandom.prototype.rand = function observedRand() {
		const value = original.call(this);
		if (recording) {
			const holder = {};
			const prevPrepare = Error.prepareStackTrace;
			// Return raw CallSite objects instead of a formatted string: we want
			// structured line numbers, and formatting thousands of stacks is the
			// expensive part.
			Error.prepareStackTrace = (_err, sites) => sites;
			Error.captureStackTrace(holder, observedRand);
			const sites = holder.stack;
			const frames = [];
			for (const site of sites) {
				const file = site.getFileName();
				// Keep only frames in the frozen algorithm; glibc-rand.js frames
				// were skipped by captureStackTrace, and Node internals never appear.
				if (!file || !file.endsWith('bonsai.js')) continue;
				frames.push({ fn: site.getFunctionName(), line: site.getLineNumber() });
			}
			Error.prepareStackTrace = prevPrepare;
			events.push({ value, frames });
		}
		return value;
	};

	try {
		recording = true;
		const growth = growBonsai(options);
		return { growth, events };
	} finally {
		recording = false;
		GlibcRandom.prototype.rand = original;
		Error.stackTraceLimit = prevLimit;
	}
}

// ---------------------------------------------------------------------------
// The observer
// ---------------------------------------------------------------------------

/**
 * A live branch, as reconstructed from the recursion stack.
 *
 * @typedef {object} BranchRecord
 * @property {number} id Sequential branch id, in creation order.
 * @property {number} type A {@link BranchType}.
 * @property {number} depth Recursion depth; the root trunk is 0.
 * @property {number} life0 The `life` this branch was called with.
 * @property {number} life Remaining life at the current iteration.
 * @property {number} iter How many loop iterations have begun (1-based).
 * @property {number} spawnLine The bonsai.js line that created this branch.
 * @property {number} curX Current column; starts at the fork point.
 * @property {number} curY Current row; starts at the fork point.
 * @property {number} curSeg Segment this branch currently hangs off, or -1.
 * @property {boolean} inDeltas True between the first `setDeltas()` draw of an
 *   iteration and that iteration's `chooseColor()` draw.
 * @property {number|null} jitter The pending `(rand() % 5) - 2` life jitter for
 *   a trunk-into-trunk spawn, consumed when the child is created.
 * @property {number} steps How many iterations of this branch drew a segment.
 */

/**
 * An exported segment. Shape is fixed by the M2 contract.
 *
 * @typedef {object} Segment
 * @property {number} id
 * @property {number} parent
 * @property {string} type
 * @property {number} x0
 * @property {number} y0
 * @property {number} x1
 * @property {number} y1
 * @property {number} life
 * @property {number} age
 * @property {number} birthStep
 * @property {number} depth
 */

/**
 * An exported leaf. Shape is fixed by the M2 contract.
 *
 * @typedef {object} Leaf
 * @property {number} x
 * @property {number} y
 * @property {number} birthStep
 * @property {number} segmentId
 */

/**
 * Turn the recorded draw stream into segments and leaves.
 *
 * The walk is a straight fold over the events. Every assertion in here is a
 * cross-check between two INDEPENDENT observations of the same fact (for
 * example: the branch type implied by the `setDeltas()` arm versus the type
 * implied by the `chooseColor()` arm versus the type implied by the spawn call
 * site). They exist so that a wrong reading fails here rather than producing a
 * plausible-looking but wrong Blender tree.
 *
 * @param {import('../src/ascii/bonsai.js').BonsaiGrowth} growth The frozen walk.
 * @param {RandEvent[]} events Every draw made during that walk.
 * @param {Record<string, number|number[]>} at Resolved call-site line numbers.
 * @returns {{segments: Segment[], leaves: Leaf[], branchCount: number, maxDepth: number}}
 */
function buildSkeleton(growth, events, at) {
	const conf = growth.conf;
	const maxLife = conf.lifeStart;
	const multiplier = conf.multiplier;

	// setDeltas() arm -> branch type. Each arm belongs to exactly one type, so
	// the first draw a branch ever makes names it.
	const SD_TYPE = new Map([
		[at.SD_TRUNK_NEW, BranchType.trunk],
		[at.SD_TRUNK_YOUNG, BranchType.trunk],
		[at.SD_TRUNK_MID_DY, BranchType.trunk],
		[at.SD_TRUNK_MID_DX, BranchType.trunk],
		[at.SD_SHOOTL_DY, BranchType.shootLeft],
		[at.SD_SHOOTL_DX, BranchType.shootLeft],
		[at.SD_SHOOTR_DY, BranchType.shootRight],
		[at.SD_SHOOTR_DX, BranchType.shootRight],
		[at.SD_DYING_DY, BranchType.dying],
		[at.SD_DYING_DX, BranchType.dying],
		[at.SD_DEAD_DY, BranchType.dead],
		[at.SD_DEAD_DX, BranchType.dead],
	]);

	// chooseColor() arm -> the colour pair the cell must have been drawn with.
	const CC_PAIR = new Map([
		[at.CC_WOOD, [ColorPair.woodBright, ColorPair.woodDark]],
		[at.CC_DYING, [ColorPair.leafBright]],
		[at.CC_DEAD, [ColorPair.leafDark]],
	]);

	const dyingSpawnLines = new Set(at.BR_SPAWN_DYING);

	/** @type {Segment[]} */
	const segments = [];
	/** @type {Leaf[]} */
	const leaves = [];
	/** @type {BranchRecord[]} */
	const stack = [];
	let branchCount = 0;
	let maxDepth = 0;
	let stepIndex = 0;
	// Set by a chooseColor event; consumed by the chooseString event that must
	// immediately follow it in the same iteration.
	let pendingSegment = null;

	const fail = (i, msg) => {
		const e = events[i];
		throw new Error(
			`export-skeleton: ${msg}\n  seed=${growth.seed} event=${i} step=${stepIndex}\n` +
				`  frames=${JSON.stringify(e && e.frames)}`,
		);
	};

	for (let i = 0; i < events.length; i++) {
		const ev = events[i];
		const frames = ev.frames;

		// Frames belonging to `branch()`, outermost first. Draws with none of
		// them are the glibc warm-up and the shootCounter seed.
		const bf = [];
		for (let k = frames.length - 1; k >= 0; k--) {
			if (frames[k].fn === 'branch') bf.push(frames[k]);
		}
		const depth = bf.length;
		if (depth === 0) continue;

		// --- sync the stack with the live recursion -------------------------
		while (stack.length > depth) {
			pendingSegment = null;
			stack.pop();
		}

		if (stack.length < depth) {
			// A branch we have not seen: its very first draw is always the
			// setDeltas() of its first iteration (bonsai.js runs `life--` then
			// `setDeltas()` before anything else).
			if (stack.length !== depth - 1) {
				fail(i, `recursion depth jumped from ${stack.length} to ${depth}`);
			}
			const inner = bf[depth - 1];
			if (inner.line !== at.SETDELTAS_CALL) {
				fail(i, `a new branch's first draw was not setDeltas() (line ${inner.line})`);
			}
			// The setDeltas() arm is the innermost non-branch frame: either
			// setDeltas itself (a direct rand()) or roll() called from setDeltas.
			const sdLine = frames[0].fn === 'roll' ? frames[1].line : frames[0].line;
			const sdType = SD_TYPE.get(sdLine);
			if (sdType === undefined) fail(i, `unrecognised setDeltas() arm at line ${sdLine}`);

			// Where did this branch come from? The parent frame's line is the
			// spawn site, which independently implies a type and a starting life.
			const parent = depth >= 2 ? stack[depth - 2] : null;
			const spawnLine = depth >= 2 ? bf[depth - 2].line : at.ROOT_SPAWN;

			let life0;
			let expectType;
			if (depth === 1) {
				if (frames[frames.length - 1].fn !== 'growBonsai') {
					fail(i, 'the root branch was not called from growBonsai()');
				}
				life0 = maxLife;
				expectType = BranchType.trunk;
				if (stack.length === 0 && segments.length !== 0) {
					fail(i, 'a second root branch appeared');
				}
			} else if (spawnLine === at.BR_SPAWN_DEAD) {
				// bonsai.js: `if (life < 3) branch(ctx, y, x, dead, life)`
				life0 = parent.life;
				expectType = BranchType.dead;
				if (!(parent.life < 3)) fail(i, `dead spawn with parent life ${parent.life} (need < 3)`);
			} else if (dyingSpawnLines.has(spawnLine)) {
				// bonsai.js: a dying trunk or a dying shoot leafs out.
				life0 = parent.life;
				expectType = BranchType.dying;
				if (!(parent.life < multiplier + 2)) {
					fail(i, `dying spawn with parent life ${parent.life} (need < ${multiplier + 2})`);
				}
			} else if (spawnLine === at.BR_SPAWN_TRUNK) {
				// bonsai.js: `branch(..., trunk, life + ((rand() % 5) - 2))`.
				if (parent.jitter === null) fail(i, 'trunk spawn without an observed life jitter');
				life0 = parent.life + parent.jitter;
				expectType = BranchType.trunk;
			} else if (spawnLine === at.BR_SPAWN_SHOOT) {
				// bonsai.js: `shootLife = life + multiplier`.
				life0 = parent.life + multiplier;
				// (shootCounter % 2) + 1 is shootLeft or shootRight; the
				// setDeltas() arm says which, so accept either here.
				expectType = sdType;
				if (sdType !== BranchType.shootLeft && sdType !== BranchType.shootRight) {
					fail(i, `shoot spawn produced type ${TYPE_NAME[sdType]}`);
				}
			} else {
				fail(i, `unrecognised branch spawn site at line ${spawnLine}`);
			}

			if (sdType !== expectType) {
				fail(
					i,
					`type disagreement: spawn site says ${TYPE_NAME[expectType]}, ` +
						`setDeltas() arm says ${TYPE_NAME[sdType]}`,
				);
			}
			if (parent) parent.jitter = null;

			/** @type {BranchRecord} */
			const rec = {
				id: branchCount++,
				type: sdType,
				depth: depth - 1,
				life0,
				life: life0,
				iter: 0,
				spawnLine,
				// A child forks from wherever its parent currently stands; the
				// root is seeded at `branch(treeRows - 1, floor(cols / 2), ...)`.
				curX: parent ? parent.curX : Math.floor(growth.cols / 2),
				curY: parent ? parent.curY : treeRowsOf(growth) - 1,
				curSeg: parent ? parent.curSeg : -1,
				inDeltas: false,
				jitter: null,
				steps: 0,
			};
			stack.push(rec);
			if (rec.depth > maxDepth) maxDepth = rec.depth;
		}

		const cur = stack[depth - 1];
		const innerLine = bf[depth - 1].line;

		// --- classify the draw ----------------------------------------------
		if (innerLine === at.SETDELTAS_CALL) {
			const sdLine = frames[0].fn === 'roll' ? frames[1].line : frames[0].line;
			const sdType = SD_TYPE.get(sdLine);
			if (sdType === undefined) fail(i, `unrecognised setDeltas() arm at line ${sdLine}`);
			if (sdType !== cur.type) {
				fail(i, `branch changed type mid-walk: ${TYPE_NAME[cur.type]} -> ${TYPE_NAME[sdType]}`);
			}
			if (!cur.inDeltas) {
				// A new iteration. bonsai.js decrements life first, so the life
				// used by this iteration is life0 - iteration index.
				cur.inDeltas = true;
				// A leaf draw follows its own chooseColor() with nothing in
				// between, so anything still pending at an iteration boundary is
				// stale by construction. Drop it rather than risk attaching a
				// leaf to the previous step.
				pendingSegment = null;
				cur.iter += 1;
				cur.life = cur.life0 - cur.iter;
				cur.jitter = null;
				if (cur.life < 0) fail(i, `iteration ${cur.iter} ran past life0 ${cur.life0}`);
			}
			// The trunk's life band is chosen by `age` and `life`; checking it
			// validates the derived life against the frozen source's own branch.
			if (cur.type === BranchType.trunk) {
				const age = maxLife - cur.life;
				const isNew = age <= 2 || cur.life < 4;
				const isYoung = !isNew && age < multiplier * 3;
				const band =
					sdLine === at.SD_TRUNK_NEW ? 'new' : sdLine === at.SD_TRUNK_YOUNG ? 'young' : 'mid';
				const want = isNew ? 'new' : isYoung ? 'young' : 'mid';
				if (band !== want) {
					fail(i, `trunk life band mismatch: source took "${band}", life=${cur.life} implies "${want}"`);
				}
			}
			continue;
		}

		if (innerLine === at.BR_REBRANCH_TEST || innerLine === at.BR_TRUNK_TEST) {
			// Guard draws. They consume randomness but say nothing new; the
			// only fact worth checking is that only trunks reach them.
			if (cur.type !== BranchType.trunk) {
				fail(i, `non-trunk ${TYPE_NAME[cur.type]} reached a trunk-only guard draw`);
			}
			continue;
		}

		if (innerLine === at.BR_SPAWN_TRUNK) {
			// This draw IS the `(rand() % 5) - 2` life jitter, evaluated as the
			// argument of the recursive call on the same line.
			cur.jitter = (ev.value % 5) - 2;
			continue;
		}

		if (innerLine === at.BR_COLOR) {
			// One chooseColor() per iteration, immediately before the draw, so
			// this event marks growth step `stepIndex`.
			if (!cur.inDeltas) fail(i, 'chooseColor() without a preceding setDeltas()');
			cur.inDeltas = false;

			const ccLine = frames[0].line;
			const allowed = CC_PAIR.get(ccLine);
			if (!allowed) fail(i, `unrecognised chooseColor() arm at line ${ccLine}`);
			const woodish =
				cur.type === BranchType.trunk ||
				cur.type === BranchType.shootLeft ||
				cur.type === BranchType.shootRight;
			const ccOk =
				(ccLine === at.CC_WOOD && woodish) ||
				(ccLine === at.CC_DYING && cur.type === BranchType.dying) ||
				(ccLine === at.CC_DEAD && cur.type === BranchType.dead);
			if (!ccOk) fail(i, `chooseColor() arm contradicts type ${TYPE_NAME[cur.type]}`);

			if (stepIndex >= growth.steps.length) fail(i, 'more iterations than growth.steps entries');
			const writes = growth.steps[stepIndex];
			if (writes.length === 0) {
				throw new Error(
					`export-skeleton: growth step ${stepIndex} of seed ${growth.seed} drew nothing — the ` +
						`branch left the ${growth.cols}x${treeRowsOf(growth)} tree window, so its position ` +
						`cannot be observed from the write log and the skeleton would have a hole. ` +
						`This does not happen for the canonical 80x40 geometry; refusing to export a ` +
						`skeleton that is silently incomplete.`,
				);
			}
			// waddstr() writes the first cell at the mvwprintw() anchor before any
			// right-margin wrap can occur, so writes[0] is exactly (y, x).
			const x1 = writes[0].x;
			const y1 = writes[0].y;
			if (!allowed.includes(writes[0].pair)) {
				fail(i, `cell colour pair ${writes[0].pair} is not one of ${allowed} for this arm`);
			}

			const seg = {
				id: segments.length,
				parent: cur.curSeg,
				type: TYPE_NAME[cur.type],
				x0: cur.curX,
				y0: cur.curY,
				x1,
				y1,
				life: cur.life,
				age: maxLife - cur.life,
				birthStep: stepIndex,
				depth: cur.depth,
			};
			// A single cbonsai step moves at most 3 columns and 1 row; a larger
			// jump would mean the segment chain has slipped.
			if (Math.abs(seg.x1 - seg.x0) > 3 || Math.abs(seg.y1 - seg.y0) > 1) {
				fail(
					i,
					`implausible step (${seg.x0},${seg.y0}) -> (${seg.x1},${seg.y1}) ` +
						`for ${seg.type}; the segment chain has desynchronised`,
				);
			}
			segments.push(seg);
			cur.curX = x1;
			cur.curY = y1;
			cur.curSeg = seg.id;
			cur.steps += 1;
			pendingSegment = { seg, branch: cur, writes };
			stepIndex += 1;
			continue;
		}

		if (innerLine === at.BR_STRING) {
			// chooseString() only draws for a leaf glyph, and it is called with
			// no intervening randomness after chooseColor().
			if (frames[0].line !== at.CS_LEAF) fail(i, `unexpected chooseString() draw line ${frames[0].line}`);
			if (!pendingSegment || pendingSegment.branch !== cur) {
				fail(i, 'a leaf draw did not follow its own chooseColor()');
			}
			const { seg, writes } = pendingSegment;
			// bonsai.js re-types a nearly-dead branch to `dying` inside
			// chooseString(), so a leaf is drawn exactly when life < 4 or the
			// branch is already dying/dead. Checking it validates `life` again.
			const leafy =
				cur.life < 4 || cur.type === BranchType.dying || cur.type === BranchType.dead;
			if (!leafy) fail(i, `leaf drawn by ${TYPE_NAME[cur.type]} with life ${cur.life}`);
			const glyph = conf.leaves[ev.value % conf.leaves.length];
			if (writes[0].ch !== glyph) {
				fail(i, `leaf glyph mismatch: drew ${JSON.stringify(writes[0].ch)}, expected ${JSON.stringify(glyph)}`);
			}
			leaves.push({ x: seg.x1, y: seg.y1, birthStep: seg.birthStep, segmentId: seg.id });
			pendingSegment = null;
			continue;
		}

		fail(i, `unclassified draw at bonsai.js line ${innerLine}`);
	}

	if (stepIndex !== growth.steps.length) {
		throw new Error(
			`export-skeleton: observed ${stepIndex} growth iterations but the frozen walk recorded ` +
				`${growth.steps.length} steps for seed ${growth.seed}`,
		);
	}
	return { segments, leaves, branchCount, maxDepth };
}

/**
 * Height of the ncurses treeWin: the terminal minus the rows `drawBase()` takes
 * (BRIEF N2 addendum — 36, not 40).
 *
 * @param {import('../src/ascii/bonsai.js').BonsaiGrowth} growth The grown tree.
 * @returns {number} Row count of the tree window.
 */
function treeRowsOf(growth) {
	const art = BASE_ART[growth.conf.baseType];
	return growth.rows - (art ? art.height : 0);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Grow one tree and produce its skeleton.
 *
 * @param {number} seed The cbonsai seed (`-s`).
 * @param {object} [options] Further `growBonsai` options; the defaults are the
 *   canonical 80x40 / lifeStart 32 / multiplier 5 configuration.
 * @returns {object} The skeleton, ready to be JSON-stringified.
 */
export function buildSkeletonForSeed(seed, options = {}) {
	const source = readFileSync(BONSAI_SRC, 'utf8');
	const at = locateCallSites(source);

	const { growth, events } = growObserved({ seed, ...options });
	const { segments, leaves, branchCount, maxDepth } = buildSkeleton(growth, events, at);
	const treeRows = treeRowsOf(growth);

	// Every step must have produced exactly one segment, and birthSteps must be
	// a dense 0..totalSteps-1 — otherwise the Blender timeline would not line up
	// with the ASCII panel's step index.
	if (segments.length !== growth.steps.length) {
		throw new Error(
			`export-skeleton: ${segments.length} segments for ${growth.steps.length} steps (seed ${seed})`,
		);
	}
	for (let i = 0; i < segments.length; i++) {
		if (segments[i].birthStep !== i) {
			throw new Error(`export-skeleton: birthStep ${segments[i].birthStep} at index ${i} (seed ${seed})`);
		}
		if (segments[i].parent >= segments[i].id) {
			throw new Error(`export-skeleton: segment ${i} has a forward parent (seed ${seed})`);
		}
	}

	return {
		seed,
		cols: growth.cols,
		rows: treeRows,
		maxLife: growth.conf.lifeStart,
		segments,
		leaves,
		totalSteps: growth.steps.length,
		meta: {
			// Everything a consumer needs that is not in the fixed contract.
			generator: 'tools/export-skeleton.mjs',
			source: {
				'src/ascii/bonsai.js': sha256(readFileSync(BONSAI_SRC)),
				'src/shared/glibc-rand.js': sha256(readFileSync(RAND_SRC)),
			},
			terminalRows: growth.rows,
			terminalCols: growth.cols,
			baseRows: growth.rows - treeRows,
			// treeWin's origin inside stdscr: the identity map documented at the
			// top of this file.
			treeOriginRow: 0,
			treeOriginCol: 0,
			// y grows downward; y = rows - 1 is the ground line.
			groundRow: treeRows - 1,
			rootX: Math.floor(growth.cols / 2),
			rootY: treeRows - 1,
			lifeStart: growth.conf.lifeStart,
			multiplier: growth.conf.multiplier,
			baseType: growth.conf.baseType,
			leafGlyphs: [...growth.conf.leaves],
			colors: [...growth.conf.colors],
			// Branches that actually drew. cbonsai's own counter is exactly twice
			// this: every branch spawns one `dead` child on its final iteration,
			// when life has already reached 0, so that child's `while (life > 0)`
			// loop never runs. Those have no geometry and are not exported.
			branchCount,
			cbonsaiBranchCount: growth.branches,
			cbonsaiShootCount: growth.shoots,
			maxDepth,
			segmentCount: segments.length,
			leafCount: leaves.length,
			// A segment/leaf with birthStep b is on screen once b + 1 steps have
			// been applied, i.e. from normalized t = (b + 1) / totalSteps.
			visibleFrom: 'stepsApplied > birthStep',
		},
	};
}

/**
 * @param {Buffer|string} data Bytes to hash.
 * @returns {string} Lowercase hex SHA-256.
 */
function sha256(data) {
	return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Round-trip reconstruction
// ---------------------------------------------------------------------------

/**
 * cbonsai's `chooseString()` glyph table (cbonsai.c:379-417), as a pure
 * function of what the skeleton records.
 *
 * This is the DRAWING rule, not the growth rule: it consumes no randomness and
 * makes no decisions. It is reproduced here on purpose — the round-trip test is
 * only meaningful if the glyph is re-derived from the exported geometry rather
 * than read back out of a cached string.
 *
 * @param {string} type Segment type name.
 * @param {number} life Remaining life at that step.
 * @param {number} dx `x1 - x0`.
 * @param {number} dy `y1 - y0`.
 * @param {string} leafGlyph The glyph to use when the step leafs out.
 * @returns {string} The branch string that was printed.
 */
export function glyphFor(type, life, dx, dy, leafGlyph) {
	// cbonsai.c:387 — a nearly-dead branch is locally re-typed to `dying`.
	const t = life < 4 ? 'dying' : type;
	switch (t) {
		case 'trunk':
			if (dy === 0) return '/~';
			if (dx < 0) return '\\|';
			if (dx === 0) return '/|\\';
			return '|/';
		case 'shootLeft':
			if (dy > 0) return '\\';
			if (dy === 0) return '\\_';
			if (dx < 0) return '\\|';
			if (dx === 0) return '/|';
			return '/';
		case 'shootRight':
			if (dy > 0) return '/';
			if (dy === 0) return '_/';
			if (dx < 0) return '\\|';
			if (dx === 0) return '/|';
			return '/';
		case 'dying':
		case 'dead':
			return leafGlyph;
		default:
			return '?';
	}
}

/**
 * Rebuild the composed 80x40 character grid from a skeleton alone.
 *
 * Draws every segment in `birthStep` order into a `rows x cols` tree window,
 * emulating the two pieces of ncurses that change what lands on screen — the
 * `wmove()` bounds check and `waddstr()`'s right-margin wrap — then lays
 * cbonsai's static pot art into the bottom rows. The pot is furniture, not
 * growth: it is read from the frozen `BASE_ART` table, which is why it is the
 * only thing here that does not come out of the JSON.
 *
 * @param {object} skel A skeleton as produced by {@link buildSkeletonForSeed}.
 * @param {number} [upToStep] Reconstruct only the first `upToStep` steps;
 *   defaults to the whole tree.
 * @returns {string} `terminalRows` lines of `cols` characters, newline-terminated.
 */
export function reconstructGrid(skel, upToStep = Infinity) {
	const cols = skel.cols;
	const treeRows = skel.rows;
	const termRows = skel.meta ? skel.meta.terminalRows : DEFAULT_ROWS;
	const leafGlyph = skel.meta && skel.meta.leafGlyphs ? skel.meta.leafGlyphs[0] : '&';
	const baseType = skel.meta ? skel.meta.baseType : 1;

	const grid = [];
	for (let y = 0; y < termRows; y++) grid.push(new Array(cols).fill(' '));

	const leafAt = new Set(skel.leaves.map((l) => l.segmentId));
	const ordered = [...skel.segments].sort((a, b) => a.birthStep - b.birthStep);

	for (const seg of ordered) {
		if (seg.birthStep >= upToStep) break;
		const str = leafAt.has(seg.id)
			? leafGlyph
			: glyphFor(seg.type, seg.life, seg.x1 - seg.x0, seg.y1 - seg.y0, leafGlyph);

		// wmove(): an out-of-window target prints nothing at all.
		let cy = seg.y1;
		let cx = seg.x1;
		if (cx < 0 || cx > cols - 1 || cy < 0 || cy > treeRows - 1) continue;

		for (const chr of str) {
			const w = wcwidth(chr.codePointAt(0));
			// ncurses blanks the tail of the line rather than splitting a
			// double-width glyph across the margin, then wraps.
			if (w >= 1 && cx + w > cols) {
				for (let k = cx; k < cols; k++) grid[cy][k] = ' ';
				cy += 1;
				cx = 0;
				if (cy > treeRows - 1) break;
			}
			grid[cy][cx] = chr;
			for (let k = 1; k < w; k++) if (cx + k < cols) grid[cy][cx + k] = chr;
			cx += w === 0 ? 0 : w;
			if (cx > cols - 1) {
				cy += 1;
				cx = 0;
				if (cy > treeRows - 1) break;
			}
		}
	}

	// drawBase(): the pot occupies the rows below the tree window, centred.
	const art = BASE_ART[baseType];
	if (art) {
		const originY = termRows - art.height;
		const originX = Math.floor(cols / 2) - Math.floor(art.width / 2);
		for (let r = 0; r < art.rows.length; r++) {
			const text = art.rows[r].map((run) => run.text).join('');
			for (let k = 0; k < text.length; k++) {
				const x = originX + k;
				const y = originY + r;
				if (x >= 0 && x < cols && y >= 0 && y < termRows) grid[y][x] = text[k];
			}
		}
	}

	return grid.map((row) => row.join('')).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Compare two grids and describe the first differences.
 *
 * @param {string} got Reconstructed grid.
 * @param {string} want Golden grid.
 * @returns {{ok: boolean, report: string[]}} Verdict and per-line detail.
 */
function diffGrids(got, want) {
	const a = got.split('\n');
	const b = want.split('\n');
	const report = [];
	let bad = 0;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] === b[i]) continue;
		bad += 1;
		if (bad <= 8) {
			report.push(`    line ${String(i).padStart(2, '0')}  reconstructed: ${JSON.stringify(a[i])}`);
			report.push(`    line ${String(i).padStart(2, '0')}  golden      : ${JSON.stringify(b[i])}`);
		}
	}
	if (bad > 8) report.push(`    ... and ${bad - 8} further differing lines`);
	return { ok: bad === 0, report };
}

/**
 * @param {string[]} argv Raw `process.argv.slice(2)`.
 * @returns {{seeds: number[], verify: boolean, outDir: string, proofPath: string}}
 */
function parseArgs(argv) {
	let seeds = [42, 1337];
	let verify = true;
	let outDir = resolve(ROOT, 'public');
	let proofPath = resolve(ROOT, 'proof/M2/skeleton-roundtrip.txt');
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--seeds') seeds = argv[++i].split(',').map((s) => Number(s.trim()));
		else if (a.startsWith('--seeds=')) seeds = a.slice(8).split(',').map((s) => Number(s.trim()));
		else if (a === '--no-verify') verify = false;
		else if (a === '--verify') verify = true;
		else if (a === '--out') outDir = resolve(ROOT, argv[++i]);
		else if (a.startsWith('--out=')) outDir = resolve(ROOT, a.slice(6));
		else if (a === '--proof') proofPath = resolve(ROOT, argv[++i]);
		else if (a.startsWith('--proof=')) proofPath = resolve(ROOT, a.slice(8));
		else throw new Error(`export-skeleton: unknown argument ${a}`);
	}
	for (const s of seeds) {
		if (!Number.isInteger(s)) throw new Error(`export-skeleton: seed must be an integer, got ${s}`);
	}
	return { seeds, verify, outDir, proofPath };
}

/**
 * Export skeletons for the requested seeds and, unless disabled, prove each one
 * round-trips to the M1 golden grid.
 *
 * @param {string[]} argv Command-line arguments.
 * @returns {number} Process exit code.
 */
function main(argv) {
	const { seeds, verify, outDir, proofPath } = parseArgs(argv);
	mkdirSync(outDir, { recursive: true });

	const lines = [];
	const push = (s = '') => {
		lines.push(s);
		console.log(s);
	};

	push('M2 — skeleton export round-trip');
	push('='.repeat(72));
	push('');
	push('Source of truth : src/ascii/bonsai.js (frozen at the M1 gate, imported unmodified)');
	push(`  sha256        : ${sha256(readFileSync(BONSAI_SRC))}`);
	push('                  src/shared/glibc-rand.js');
	push(`  sha256        : ${sha256(readFileSync(RAND_SRC))}`);
	push('');
	push('Method          : GlibcRandom.prototype.rand is wrapped at RUNTIME and every draw');
	push('                  is tagged with its V8 stack trace. The bonsai.js source lines in');
	push('                  that trace identify the branch type, the life band, the spawn');
	push('                  site and the iteration boundary. Segment positions are read from');
	push('                  the frozen walk\'s own write log (growth.steps[i][0]), never');
	push('                  recomputed. No growth logic is reimplemented here.');
	push('');
	push('Coordinates     : cbonsai treeWin space. x in [0,80), y in [0,36), y=0 TOP,');
	push('                  y=35 the ground row. treeWin origin is stdscr (0,0), so the map');
	push('                  into the 80x40 terminal is the identity; terminal rows 36-39 are');
	push('                  the base art. The trunk is seeded at (row 35, col 40).');
	push('');

	let allOk = true;
	for (const seed of seeds) {
		const skel = buildSkeletonForSeed(seed);
		const file = resolve(outDir, `skeleton-${seed}.json`);
		writeFileSync(file, JSON.stringify(skel, null, 2) + '\n');

		push('-'.repeat(72));
		push(`seed ${seed}`);
		push('-'.repeat(72));
		push(`  file            : ${relative(ROOT, file).replace(/\\/g, '/')}`);
		push(`  grid            : ${skel.cols} x ${skel.rows} (tree window) in an ${skel.meta.terminalCols} x ${skel.meta.terminalRows} terminal`);
		push(`  maxLife         : ${skel.maxLife}`);
		push(`  totalSteps      : ${skel.totalSteps}`);
		push(`  segments        : ${skel.segments.length}`);
		push(`  leaves          : ${skel.leaves.length}`);
		push(`  branches        : ${skel.meta.branchCount} drawn (cbonsai counts ${skel.meta.cbonsaiBranchCount}, incl. ${skel.meta.cbonsaiBranchCount - skel.meta.branchCount} spawned with life<=0 that draw nothing)`);
		push(`  shoots          : ${skel.meta.cbonsaiShootCount}`);
		push(`  max depth       : ${skel.meta.maxDepth}`);

		const byType = {};
		for (const s of skel.segments) byType[s.type] = (byType[s.type] || 0) + 1;
		push(`  by type         : ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(' ')}`);

		if (!verify) {
			push('  round-trip      : SKIPPED (--no-verify)');
			push('');
			continue;
		}

		// (a) the skeleton alone must rebuild the finished grid, and that grid
		//     must equal cbonsai's own print-mode output from the M1 gate.
		const rebuilt = reconstructGrid(skel);
		const goldenPath = resolve(ROOT, `proof/M1/golden/seed-${seed}.plain.txt`);
		let golden = null;
		try {
			golden = readFileSync(goldenPath, 'utf8');
		} catch {
			/* no golden captured for this seed; the renderer check below still runs */
		}

		// (b) and it must agree with the frozen JS renderer, which is the thing
		//     the browser actually paints.
		const live = growBonsai({ seed }).toPlainText();
		const vsLive = diffGrids(rebuilt, live);

		push(`  rebuilt grid    : ${rebuilt.split('\n').length - 1} lines x ${rebuilt.split('\n')[0].length} chars`);
		let vsGolden = { ok: true, report: [] };
		if (golden === null) {
			push(`  vs golden       : NO GOLDEN at ${relative(ROOT, goldenPath).replace(/\\/g, '/')} (seed not in the M1 set)`);
		} else {
			vsGolden = diffGrids(rebuilt, golden);
			push(`  golden          : ${relative(ROOT, goldenPath).replace(/\\/g, '/')} (cbonsai -p -s ${seed}, SGR stripped)`);
			push(`  vs golden       : ${vsGolden.ok ? 'IDENTICAL' : 'DIFFERS'}`);
			for (const r of vsGolden.report) push(r);
		}
		push(`  vs JS renderer  : ${vsLive.ok ? 'IDENTICAL' : 'DIFFERS'}`);
		for (const r of vsLive.report) push(r);

		// (c) growth ORDER must match too, not just the final frame: replaying
		//     the skeleton to step N must equal the frozen renderer at step N.
		const growth = growBonsai({ seed });
		let orderOk = true;
		const orderDetail = [];
		for (let step = 0; step <= skel.totalSteps; step++) {
			if (reconstructGrid(skel, step) === growth.toPlainText(growth.frameAtStep(step))) continue;
			orderOk = false;
			if (orderDetail.length < 5) orderDetail.push(`    MISMATCH at step ${step} / ${skel.totalSteps}`);
		}
		push(
			`  growth order    : ${orderOk ? `IDENTICAL at every one of ${skel.totalSteps + 1} intermediate steps (exhaustive)` : 'MISMATCH'}`,
		);
		for (const d of orderDetail) push(d);
		// Spot-print the sampled stages Fable reads, so the proof shows its work.
		for (let k = 0; k <= 4; k++) {
			const step = Math.round((k / 4) * skel.totalSteps);
			const ok = reconstructGrid(skel, step) === growth.toPlainText(growth.frameAtStep(step));
			push(`    t=${(k / 4).toFixed(2)}  step ${String(step).padStart(4)} / ${skel.totalSteps}  ${ok ? 'match' : 'MISMATCH'}`);
		}

		const ok = vsGolden.ok && vsLive.ok && orderOk;
		allOk = allOk && ok;
		push(`  RESULT          : ${ok ? 'PASS' : 'FAIL'}`);
		push('');
	}

	if (verify) {
		// The observer monkey-patches GlibcRandom.prototype.rand and restores it
		// in a `finally`. Prove there is no residue: after every export above, in
		// this same process, the frozen port must still reproduce every M1 golden
		// byte for byte.
		push('-'.repeat(72));
		push('frozen source unaffected by the observer (same process, patch removed)');
		push('-'.repeat(72));
		let residueOk = true;
		for (const seed of [1, 42, 1337, 99999, 2147483647]) {
			const goldenPath = resolve(ROOT, `proof/M1/golden/seed-${seed}.plain.txt`);
			let golden;
			try {
				golden = readFileSync(goldenPath, 'utf8');
			} catch {
				push(`  seed ${String(seed).padEnd(10)} : golden missing, skipped`);
				continue;
			}
			const ok = growBonsai({ seed }).toPlainText() === golden;
			if (!ok) residueOk = false;
			push(`  seed ${String(seed).padEnd(10)} : ${ok ? 'M1 golden still reproduces exactly' : 'REGRESSED'}`);
		}
		allOk = allOk && residueOk;
		push('');
	}

	push('='.repeat(72));
	push(`OVERALL: ${allOk ? 'PASS' : 'FAIL'}`);

	if (verify) {
		mkdirSync(dirname(proofPath), { recursive: true });
		writeFileSync(proofPath, lines.join('\n') + '\n');
		console.log(`\nwrote ${relative(ROOT, proofPath).replace(/\\/g, '/')}`);
	}
	return allOk ? 0 : 1;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('export-skeleton.mjs')) {
	process.exitCode = main(process.argv.slice(2));
}

export default buildSkeletonForSeed;
