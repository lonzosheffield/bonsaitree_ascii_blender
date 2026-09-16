/**
 * bonsai.js — a faithful JavaScript port of the cbonsai growth algorithm.
 *
 * THIS IS A TRANSLATION, NOT A REINTERPRETATION.
 *
 * Every line here traces to `vendor/cbonsai/cbonsai.c`. Line references in the
 * comments are to that file. The three things that make the port exact, in
 * descending order of how easy they are to get wrong:
 *
 *  1. THE ORDER OF rand() CALLS IS PART OF THE ALGORITHM.
 *     A correct generator consumed in the wrong order yields a different tree.
 *     Every `rng.rand()` below is annotated with the C line it stands in for,
 *     and the recursive calls in `branch()` deliberately happen BEFORE the
 *     parent's own `chooseColor()` / `chooseString()` draws, exactly as in C
 *     (cbonsai.c:439-477 precede cbonsai.c:491-494).
 *
 *  2. `setDeltas()` IS THE TREE'S SHAPE (cbonsai.c:289-377).
 *     Every branch of every age band is reproduced verbatim, including the
 *     integer truncation in `(int)(multiplier * 0.5)`.
 *
 *  3. TERMINAL GEOMETRY IS AN INPUT (BRIEF N2).
 *     stdscr is 40x80; the base window steals 4 rows, so treeWin is 36x80 and
 *     the trunk starts at (y=35, x=40). Branch length, the ground-clamp at
 *     cbonsai.c:436, and ncurses' clipping/line-wrap at the window edge all
 *     depend on those numbers. They are not decoration.
 *
 * The port also emulates just enough ncurses to be byte-exact:
 *   - `wmove()` bounds-checking, so an out-of-window branch draws nothing
 *     (cbonsai.c:502-503 calls mvwprintw, which fails silently off-window);
 *   - the right-margin wrap in `waddch()`, which carries the tail of a 2-3
 *     character branch string onto column 0 of the next row;
 *   - attribute bookkeeping (`wattron` replaces the colour pair, `wattroff`
 *     clears A_BOLD after every character, cbonsai.c:505);
 *   - `overlay()` of baseWin and treeWin onto stdscr (cbonsai.c:1084-1085),
 *     which is non-destructive: blank cells are not copied;
 *   - `printstdscr()` (cbonsai.c:719-768), including the malformed `ESC[3-1m`
 *     it emits for default-coloured cells.
 *
 * PURITY: no clock, no I/O, no module-level mutable state. The same
 * (seed, rows, cols, conf) always produces byte-identical output.
 *
 * @module ascii/bonsai
 */

import { GlibcRandom } from '../shared/glibc-rand.js';

// ---------------------------------------------------------------------------
// cbonsai constants
// ---------------------------------------------------------------------------

/**
 * `enum branchType {trunk, shootLeft, shootRight, dying, dead}` — cbonsai.c:23.
 * The numeric values matter: `setDeltas()` switches on them as `case 1:` .. and
 * `branch()` computes a shoot type as `(shootCounter % 2) + 1`.
 * @readonly
 * @enum {number}
 */
export const BranchType = Object.freeze({
	trunk: 0,
	shootLeft: 1,
	shootRight: 2,
	dying: 3,
	dead: 4,
});

/**
 * ncurses colour-pair ids, from the `COLOR_*` macros at cbonsai.c:17-21.
 * @readonly
 * @enum {number}
 */
export const ColorPair = Object.freeze({
	/** `COLOR_LEAF_DARK`  = COLOR_PAIR(1) -> conf.colors[0], default 2 */
	leafDark: 1,
	/** `COLOR_WOOD_DARK`  = COLOR_PAIR(2) -> conf.colors[1], default 3 */
	woodDark: 2,
	/** `COLOR_LEAF_BRIGHT`= COLOR_PAIR(3) -> conf.colors[2], default 10 */
	leafBright: 3,
	/** `COLOR_WOOD_BRIGHT`= COLOR_PAIR(4) -> conf.colors[3], default 11 */
	woodBright: 4,
	/** `COLOR_TEXT`       = COLOR_PAIR(5) -> 8 on a 256-colour terminal */
	text: 5,
});

/** cbonsai's `-L` default (`.lifeStart = 32`, cbonsai.c:815). */
export const DEFAULT_LIFE_START = 32;
/** cbonsai's `-M` default (`.multiplier = 5`, cbonsai.c:816). */
export const DEFAULT_MULTIPLIER = 5;
/** cbonsai's `-b` default (`.baseType = 1`, cbonsai.c:817). */
export const DEFAULT_BASE_TYPE = 1;
/** cbonsai's `-c` default (`char leavesInput[128] = "&"`, cbonsai.c:857). */
export const DEFAULT_LEAVES = Object.freeze(['&']);
/** cbonsai's `-k` default (`"2,3,10,11"`, cbonsai.c:858). */
export const DEFAULT_COLORS = Object.freeze([2, 3, 10, 11]);
/** BRIEF N2: the canonical grid. `COLUMNS=80 LINES=40`, pinned in Docker. */
export const DEFAULT_ROWS = 40;
/** BRIEF N2: the canonical grid. `COLUMNS=80 LINES=40`, pinned in Docker. */
export const DEFAULT_COLS = 80;

/**
 * The ASCII-art pots from `drawBase()` (cbonsai.c:168-205), as runs of
 * (text, colour pair, bold) in the exact order cbonsai prints them. Row 0 is a
 * sequence of coloured runs; rows 1..n are single runs drawn with whatever
 * attributes were left on the window by row 0 — for base 1 that is
 * `A_BOLD | COLOR_TEXT`, for base 2 it is `COLOR_TEXT` with no bold.
 * @type {Readonly<Record<number, {width: number, height: number, rows: {text: string, pair: number, bold: boolean}[][]}>>}
 */
export const BASE_ART = Object.freeze({
	1: Object.freeze({
		// `baseWidth = 31; baseHeight = 4;` — cbonsai.c:214-215
		width: 31,
		height: 4,
		rows: [
			[
				{ text: ':', pair: ColorPair.text, bold: true },
				{ text: '___________', pair: ColorPair.leafBright, bold: true },
				{ text: './~~~\\.', pair: ColorPair.woodBright, bold: true },
				{ text: '___________', pair: ColorPair.leafBright, bold: true },
				{ text: ':', pair: ColorPair.text, bold: true },
			],
			[{ text: ' \\                           / ', pair: ColorPair.text, bold: true }],
			[{ text: '  \\_________________________/ ', pair: ColorPair.text, bold: true }],
			[{ text: '  (_)                     (_)', pair: ColorPair.text, bold: true }],
		],
	}),
	2: Object.freeze({
		// `baseWidth = 15; baseHeight = 3;` — cbonsai.c:217-218
		width: 15,
		height: 3,
		rows: [
			[
				{ text: '(', pair: ColorPair.text, bold: false },
				{ text: '---', pair: ColorPair.leafBright, bold: false },
				{ text: './~~~\\.', pair: ColorPair.woodBright, bold: false },
				{ text: '---', pair: ColorPair.leafBright, bold: false },
				{ text: ')', pair: ColorPair.text, bold: false },
			],
			[{ text: ' (           ) ', pair: ColorPair.text, bold: false }],
			[{ text: '  (_________)  ', pair: ColorPair.text, bold: false }],
		],
	}),
});

// ---------------------------------------------------------------------------
// wcwidth — enough of POSIX wcwidth(3) for cbonsai's needs
// ---------------------------------------------------------------------------

/** East Asian Wide / Fullwidth ranges, for the `x % wcwidth(wc)` test. */
const WIDE_RANGES = [
	[0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
	[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
	[0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
	[0xff00, 0xff60], [0xffe0, 0xffe6], [0x17000, 0x18aff], [0x1b000, 0x1b2ff],
	[0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

/** Zero-width: combining marks and format characters. */
const ZERO_RANGES = [[0x0300, 0x036f], [0x200b, 0x200f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff]];

function inRanges(cp, ranges) {
	for (let i = 0; i < ranges.length; i++) {
		if (cp >= ranges[i][0] && cp <= ranges[i][1]) return true;
	}
	return false;
}

/**
 * Display width of a code point, as `wcwidth(3)` would report it.
 *
 * cbonsai calls this twice: once at cbonsai.c:502 to decide whether a branch
 * may be drawn at all (`x % wcwidth(wc) == 0`), and once inside
 * `printstdscr()` at cbonsai.c:760 to know how many cells a glyph occupies.
 * For the default `&` leaf and every branch string it is 1, which makes the
 * cbonsai.c:502 test vacuously true — but a `-c` list of wide glyphs changes
 * that, so the real rule is implemented.
 *
 * @param {number} cp A Unicode code point.
 * @returns {number} 0, 1 or 2.
 */
export function wcwidth(cp) {
	if (cp === 0) return 0;
	if (inRanges(cp, ZERO_RANGES)) return 0;
	if (inRanges(cp, WIDE_RANGES)) return 2;
	return 1;
}

// ---------------------------------------------------------------------------
// A very small ncurses WINDOW
// ---------------------------------------------------------------------------

const BLANK = ' ';

/**
 * The parts of an ncurses `WINDOW` that change what lands on screen: a cell
 * grid, a cursor, and the current attribute set.
 *
 * Cells carry `width` so that double-width glyphs occupy two cells (the second
 * being a `width === 0` continuation cell, as ncurses does), which
 * `printstdscr()` then skips over.
 */
class Win {
	/**
	 * @param {number} rows Window height.
	 * @param {number} cols Window width.
	 * @param {number} begY Screen row of the window's origin.
	 * @param {number} begX Screen column of the window's origin.
	 */
	constructor(rows, cols, begY, begX) {
		this.rows = rows;
		this.cols = cols;
		this.begY = begY;
		this.begX = begX;
		/** `win->_maxy` — the LAST valid row, not the count. */
		this.maxY = rows - 1;
		/** `win->_maxx` — the LAST valid column, not the count. */
		this.maxX = cols - 1;

		const n = rows * cols;
		/** @type {string[]} one character per cell */
		this.ch = new Array(n).fill(BLANK);
		/** @type {Uint8Array} A_BOLD per cell */
		this.bold = new Uint8Array(n);
		/** @type {Uint8Array} colour pair per cell (0 = terminal default) */
		this.pair = new Uint8Array(n);
		/** @type {Uint8Array} glyph width per cell; 0 marks a continuation cell */
		this.width = new Uint8Array(n).fill(1);

		this.curY = 0;
		this.curX = 0;
		/** current `A_BOLD` state, toggled by wattron/wattroff */
		this.attrBold = false;
		/** current colour pair; `wattron(COLOR_PAIR(n))` REPLACES it */
		this.attrPair = 0;
	}
}

/**
 * `wattron(win, attrs)` for the two attributes cbonsai uses.
 *
 * ncurses' `toggle_attr_on()` special-cases colour: when the attribute set
 * being turned on names a pair, the window's existing pair is cleared rather
 * than OR-ed. A_BOLD, having no pair bits, is a plain OR. That is why
 * `wattron(A_BOLD | COLOR_WOOD_BRIGHT)` both sets bold and replaces the colour.
 *
 * @param {Win} win Target window.
 * @param {number} pair Colour pair to switch to, or 0 to leave the colour alone.
 * @param {boolean} bold Whether to add A_BOLD.
 * @returns {void}
 */
function wattron(win, pair, bold) {
	if (pair > 0) win.attrPair = pair;
	if (bold) win.attrBold = true;
}

/**
 * `wattroff(win, A_BOLD)` — cbonsai.c:505, run after every character drawn.
 * @param {Win} win Target window.
 * @returns {void}
 */
function wattroffBold(win) {
	win.attrBold = false;
}

/**
 * `wmove()`. Returns false (ERR) for an out-of-window position, in which case
 * the `mvwprintw()` that called it prints nothing at all — this is how a branch
 * that wanders off the top or the sides of treeWin silently disappears.
 *
 * ncurses' LEGALYX macro is `x >= 0 && x <= _maxx && y >= 0 && y <= _maxy`.
 *
 * @param {Win} win Target window.
 * @param {number} y Row.
 * @param {number} x Column.
 * @returns {boolean} true on OK, false on ERR.
 */
function wmove(win, y, x) {
	if (x >= 0 && x <= win.maxX && y >= 0 && y <= win.maxY) {
		win.curY = y;
		win.curX = x;
		return true;
	}
	return false;
}

/**
 * ncurses' `wrap_to_next_line()`: advance to column 0 of the next row. With
 * scrolling disabled (the default for a `newwin()`), falling off the bottom
 * returns ERR and the rest of the string is dropped.
 *
 * @param {Win} win Target window.
 * @returns {boolean} true on OK, false on ERR.
 */
function wrapToNextLine(win) {
	win.curY += 1;
	if (win.curY > win.maxY) {
		win.curY = win.maxY;
		win.curX = win.maxX;
		return false;
	}
	win.curX = 0;
	return true;
}

/**
 * Write one cell, recording the write so the growth can be replayed step by
 * step later.
 *
 * ncurses' `render_char()` turns a plain space with no attributes of its own
 * into the window's background cell — which is why the spaces inside the base
 * art are NOT carried onto stdscr by `overlay()`, and why they show up in
 * cbonsai's own output as default-coloured blanks.
 *
 * @param {Win} win Target window.
 * @param {number} y Row.
 * @param {number} x Column.
 * @param {string} ch The character.
 * @param {number} width Glyph width; 0 for a continuation cell.
 * @param {{y: number, x: number, ch: string, bold: number, pair: number, width: number}[]|null} sink Write log, or null.
 * @returns {void}
 */
function setCell(win, y, x, ch, width, sink) {
	const idx = y * win.cols + x;
	const blank = ch === BLANK && width === 1;
	const bold = blank ? 0 : win.attrBold ? 1 : 0;
	const pair = blank ? 0 : win.attrPair;
	win.ch[idx] = ch;
	win.bold[idx] = bold;
	win.pair[idx] = pair;
	win.width[idx] = width;
	if (sink) sink.push({ y, x, ch, bold, pair, width });
}

/**
 * `waddstr()` — add a string at the cursor, honouring the right-margin wrap.
 *
 * The wrap is the reason this is emulated rather than hand-waved: a branch drawn
 * at column 79 with the 2-character string `/~` puts `/` at (y, 79) and `~` at
 * (y+1, 0). Clipping instead of wrapping would silently change the tree.
 *
 * @param {Win} win Target window.
 * @param {string} str The string to add.
 * @param {{y: number, x: number, ch: string, bold: number, pair: number, width: number}[]|null} sink Write log, or null.
 * @returns {boolean} true on OK, false if the window bottom was hit.
 */
function waddstr(win, str, sink) {
	for (const chr of str) {
		const w = wcwidth(chr.codePointAt(0));

		// ncurses fills the tail of the line with blanks and wraps rather than
		// splitting a double-width glyph across the right margin.
		if (w >= 1 && win.curX + w > win.maxX + 1) {
			for (let i = win.curX; i <= win.maxX; i++) setCell(win, win.curY, i, BLANK, 1, sink);
			if (!wrapToNextLine(win)) return false;
		}

		// ncurses stores the SAME wide character in the continuation cell, flagged
		// as an extension rather than blanked. That matters: `printstdscr()` has
		// no notion of continuation cells (cbonsai.c:751 just prints whatever
		// glyph the cell holds), so an extension cell whose lead was later
		// overwritten prints as a second, whole glyph. Storing '' here would
		// silently drop it.
		setCell(win, win.curY, win.curX, chr, w === 0 ? 1 : w, sink);
		for (let k = 1; k < w; k++) setCell(win, win.curY, win.curX + k, chr, 0, sink);

		win.curX += w === 0 ? 0 : w;
		if (win.curX > win.maxX && !wrapToNextLine(win)) return false;
	}
	return true;
}

/**
 * `mvwprintw(win, y, x, "%s", str)` — move, then add. A failed move prints
 * nothing, which is the whole point.
 *
 * @param {Win} win Target window.
 * @param {number} y Row.
 * @param {number} x Column.
 * @param {string} str The string to print.
 * @param {{y: number, x: number, ch: string, bold: number, pair: number, width: number}[]|null} sink Write log, or null.
 * @returns {boolean} true if anything was printed.
 */
function mvwprintw(win, y, x, str, sink) {
	if (!wmove(win, y, x)) return false;
	return waddstr(win, str, sink);
}

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

/**
 * `roll(&dice, mod)` — cbonsai.c:243. Note it is `rand() % mod`, NOT a scaled
 * float: the low bits of glibc's `random()` are what shape the tree.
 *
 * @param {GlibcRandom} rng The generator.
 * @param {number} mod Exclusive upper bound.
 * @returns {number} A value in [0, mod).
 */
function roll(rng, mod) {
	return rng.rand() % mod;
}

/**
 * `setDeltas()` — cbonsai.c:289-377. THIS FUNCTION IS THE TREE'S SHAPE.
 *
 * Ported branch for branch, including:
 *  - the `(int)(multiplier * 0.5)` truncation at cbonsai.c:305 (for the default
 *    multiplier of 5 that is `(int)2.5` == 2, so a young trunk rises every
 *    other step, despite the comment claiming `multiplier * 0.8`);
 *  - the dead-code guards like `if (dice >= 0 && dice <= 0)`, kept as-is so the
 *    dice-band boundaries stay legible against the C;
 *  - the exact number and order of draws per type, which is what keeps the
 *    stream aligned: trunk consumes 1 draw when new/dying, 1 when young, 2 when
 *    middle-aged; shoots and `dying` consume 2; `dead` consumes 2.
 *
 * @param {GlibcRandom} rng The generator.
 * @param {number} type A {@link BranchType}.
 * @param {number} life Remaining life of this branch.
 * @param {number} age `conf.lifeStart - life` (cbonsai.c:431 — the GLOBAL life start).
 * @param {number} multiplier `conf.multiplier`.
 * @returns {{dx: number, dy: number}} The step to take.
 */
function setDeltas(rng, type, life, age, multiplier) {
	let dx = 0;
	let dy = 0;
	let dice;

	switch (type) {
		case BranchType.trunk: {
			// new or dead trunk — cbonsai.c:297
			if (age <= 2 || life < 4) {
				dy = 0;
				dx = (rng.rand() % 3) - 1; // cbonsai.c:299
			}
			// young trunk should grow wide — cbonsai.c:302
			else if (age < multiplier * 3) {
				// every (multiplier * 0.5) steps, raise tree to next level
				const period = Math.trunc(multiplier * 0.5); // cbonsai.c:305
				if (period === 0) {
					// C divides by zero here and dies; refuse rather than
					// invent a shape cbonsai does not have.
					throw new RangeError(
						`multiplier ${multiplier} makes (int)(multiplier * 0.5) zero; cbonsai divides by zero here`,
					);
				}
				if (age % period === 0) dy = -1;
				else dy = 0;

				dice = roll(rng, 10); // cbonsai.c:308
				if (dice >= 0 && dice <= 0) dx = -2;
				else if (dice >= 1 && dice <= 3) dx = -1;
				else if (dice >= 4 && dice <= 5) dx = 0;
				else if (dice >= 6 && dice <= 8) dx = 1;
				else if (dice >= 9 && dice <= 9) dx = 2;
			}
			// middle-aged trunk — cbonsai.c:316
			else {
				dice = roll(rng, 10); // cbonsai.c:317
				if (dice > 2) dy = -1;
				else dy = 0;
				dx = (rng.rand() % 3) - 1; // cbonsai.c:320
			}
			break;
		}

		case BranchType.shootLeft: {
			// left shoot: trend left and little vertical movement — cbonsai.c:324
			dice = roll(rng, 10); // cbonsai.c:325
			if (dice >= 0 && dice <= 1) dy = -1;
			else if (dice >= 2 && dice <= 7) dy = 0;
			else if (dice >= 8 && dice <= 9) dy = 1;

			dice = roll(rng, 10); // cbonsai.c:330
			if (dice >= 0 && dice <= 1) dx = -2;
			else if (dice >= 2 && dice <= 5) dx = -1;
			else if (dice >= 6 && dice <= 8) dx = 0;
			else if (dice >= 9 && dice <= 9) dx = 1;
			break;
		}

		case BranchType.shootRight: {
			// right shoot: trend right and little vertical movement — cbonsai.c:337
			dice = roll(rng, 10); // cbonsai.c:338
			if (dice >= 0 && dice <= 1) dy = -1;
			else if (dice >= 2 && dice <= 7) dy = 0;
			else if (dice >= 8 && dice <= 9) dy = 1;

			dice = roll(rng, 10); // cbonsai.c:343
			if (dice >= 0 && dice <= 1) dx = 2;
			else if (dice >= 2 && dice <= 5) dx = 1;
			else if (dice >= 6 && dice <= 8) dx = 0;
			else if (dice >= 9 && dice <= 9) dx = -1;
			break;
		}

		case BranchType.dying: {
			// dying: discourage vertical growth; trend left/right (-3,3) — cbonsai.c:350
			dice = roll(rng, 10); // cbonsai.c:351
			if (dice >= 0 && dice <= 1) dy = -1;
			else if (dice >= 2 && dice <= 8) dy = 0;
			else if (dice >= 9 && dice <= 9) dy = 1;

			dice = roll(rng, 15); // cbonsai.c:356 — NOTE: 15, not 10.
			if (dice >= 0 && dice <= 0) dx = -3;
			else if (dice >= 1 && dice <= 2) dx = -2;
			else if (dice >= 3 && dice <= 5) dx = -1;
			else if (dice >= 6 && dice <= 8) dx = 0;
			else if (dice >= 9 && dice <= 11) dx = 1;
			else if (dice >= 12 && dice <= 13) dx = 2;
			else if (dice >= 14 && dice <= 14) dx = 3;
			break;
		}

		case BranchType.dead: {
			// dead: fill in surrounding area — cbonsai.c:366
			dice = roll(rng, 10); // cbonsai.c:367
			if (dice >= 0 && dice <= 2) dy = -1;
			else if (dice >= 3 && dice <= 6) dy = 0;
			else if (dice >= 7 && dice <= 9) dy = 1;
			dx = (rng.rand() % 3) - 1; // cbonsai.c:371
			break;
		}

		default:
			break;
	}

	return { dx, dy };
}

/**
 * `chooseColor()` — cbonsai.c:267-286. One `rand()` per call, ALWAYS, even in
 * the `dying` case where both outcomes use the same colour pair and only bold
 * differs. Skipping that draw because "it doesn't change the colour" would
 * desynchronise the whole stream.
 *
 * @param {GlibcRandom} rng The generator.
 * @param {number} type A {@link BranchType}.
 * @returns {{pair: number, bold: boolean}} The attributes to turn on.
 */
function chooseColor(rng, type) {
	switch (type) {
		case BranchType.trunk:
		case BranchType.shootLeft:
		case BranchType.shootRight:
			// cbonsai.c:272
			if (rng.rand() % 2 === 0) return { pair: ColorPair.woodBright, bold: true };
			return { pair: ColorPair.woodDark, bold: false };

		case BranchType.dying:
			// cbonsai.c:277
			if (rng.rand() % 10 === 0) return { pair: ColorPair.leafBright, bold: true };
			return { pair: ColorPair.leafBright, bold: false };

		case BranchType.dead:
			// cbonsai.c:282
			if (rng.rand() % 3 === 0) return { pair: ColorPair.leafDark, bold: true };
			return { pair: ColorPair.leafDark, bold: false };

		default:
			return { pair: 0, bold: false };
	}
}

/**
 * `chooseString()` — cbonsai.c:379-417.
 *
 * Two things to keep: the local re-typing of a nearly-dead branch to `dying`
 * (cbonsai.c:387), which is what turns the tip of a trunk into leaves; and the
 * `rand() % leavesSize` draw for leaves (cbonsai.c:412), which is consumed even
 * for the default single-element leaf list where the result is always 0.
 *
 * @param {GlibcRandom} rng The generator.
 * @param {string[]} leaves `conf.leaves`.
 * @param {number} type A {@link BranchType}.
 * @param {number} life Remaining life.
 * @param {number} dx Step in x.
 * @param {number} dy Step in y.
 * @returns {string} The branch string.
 */
function chooseString(rng, leaves, type, life, dx, dy) {
	let t = type;
	if (life < 4) t = BranchType.dying; // cbonsai.c:387

	switch (t) {
		case BranchType.trunk:
			if (dy === 0) return '/~';
			if (dx < 0) return '\\|';
			if (dx === 0) return '/|\\';
			return '|/';

		case BranchType.shootLeft:
			if (dy > 0) return '\\';
			if (dy === 0) return '\\_';
			if (dx < 0) return '\\|';
			if (dx === 0) return '/|';
			return '/';

		case BranchType.shootRight:
			if (dy > 0) return '/';
			if (dy === 0) return '_/';
			if (dx < 0) return '\\|';
			if (dx === 0) return '/|';
			return '/';

		case BranchType.dying:
		case BranchType.dead:
			return leaves[rng.rand() % leaves.length]; // cbonsai.c:412

		default:
			return '?'; // the malloc'd fallback at cbonsai.c:385
	}
}

/**
 * `branch()` — cbonsai.c:419-513. The recursive growth model.
 *
 * The rand() call order inside one loop iteration, which is the part that must
 * not move:
 *
 *   1. `setDeltas()`                                    (1 or 2 draws)
 *   2. the recursive child, if any — and the CHILD'S ENTIRE SUBTREE consumes
 *      the stream here, before the parent draws its own character
 *   3. `rand() % 3` for the trunk re-branch test, but ONLY when `type == trunk`
 *      (C's `&&` short-circuits, so a shoot never consumes this draw)
 *   4. `rand() % 8` for "branch into another trunk", evaluated before the
 *      `life > 7` guard, so it is consumed even when life is too low
 *   5. `rand() % 5` for the child trunk's life jitter, when 4 succeeded
 *   6. `chooseColor()`                                  (1 draw)
 *   7. `chooseString()`                                 (1 draw for leaves)
 *
 * @param {object} ctx Mutable growth context.
 * @param {number} y Row to grow from.
 * @param {number} x Column to grow from.
 * @param {number} type A {@link BranchType}.
 * @param {number} life Starting life for this branch.
 * @returns {void}
 */
function branch(ctx, y, x, type, life) {
	const { rng, conf, treeWin } = ctx;
	const multiplier = conf.multiplier;

	ctx.counters.branches += 1; // cbonsai.c:420
	let shootCooldown = multiplier; // cbonsai.c:424

	while (life > 0) {
		// cbonsai.c:427 checkKeyPress() — in print mode this reads nothing and
		// consumes no randomness, so there is nothing to port.

		life -= 1; // cbonsai.c:430
		const age = conf.lifeStart - life; // cbonsai.c:431 — GLOBAL lifeStart

		const d = setDeltas(rng, type, life, age, multiplier); // cbonsai.c:433
		let dx = d.dx;
		let dy = d.dy;

		// cbonsai.c:435-436 — getmaxy() is the ROW COUNT (36), not the last row.
		const maxY = treeWin.rows;
		if (dy > 0 && y > maxY - 2) dy -= 1;

		if (life < 3) {
			// near-dead branch should branch into a lot of leaves — cbonsai.c:439
			branch(ctx, y, x, BranchType.dead, life);
		} else if (type === BranchType.trunk && life < multiplier + 2) {
			// dying trunk should branch into a lot of leaves — cbonsai.c:443
			branch(ctx, y, x, BranchType.dying, life);
		} else if (
			(type === BranchType.shootLeft || type === BranchType.shootRight) &&
			life < multiplier + 2
		) {
			// dying shoot should branch into a lot of leaves — cbonsai.c:447
			branch(ctx, y, x, BranchType.dying, life);
		} else if (
			// cbonsai.c:455. `type == trunk` is evaluated FIRST; the rand() is
			// only consumed for trunks, and it is consumed before the
			// `life % multiplier` test because `||` evaluates left to right.
			type === BranchType.trunk &&
			(rng.rand() % 3 === 0 || life % multiplier === 0)
		) {
			// cbonsai.c:458 — the rand() is the LEFT operand of &&, so it is
			// always drawn, even when `life > 7` is what actually fails.
			if (rng.rand() % 8 === 0 && life > 7) {
				shootCooldown = multiplier * 2; // cbonsai.c:459
				// cbonsai.c:460 — the life jitter is drawn before the call.
				branch(ctx, y, x, BranchType.trunk, life + ((rng.rand() % 5) - 2));
			} else if (shootCooldown <= 0) {
				// cbonsai.c:464
				shootCooldown = multiplier * 2;
				const shootLife = life + multiplier; // cbonsai.c:467

				ctx.counters.shoots += 1; // cbonsai.c:470
				// cbonsai.c:471 — `int` overflow is part of the contract: a
				// shootCounter seeded from rand() can wrap to negative, and C's
				// `%` keeps the sign, which JS also does.
				ctx.counters.shootCounter = (ctx.counters.shootCounter + 1) | 0;

				// cbonsai.c:475 — (shootCounter % 2) + 1 is shootLeft/shootRight
				branch(ctx, y, x, (ctx.counters.shootCounter % 2) + 1, shootLife);
			}
		}
		shootCooldown -= 1; // cbonsai.c:478 — unconditional

		// move in x and y directions — cbonsai.c:488-489
		x += dx;
		y += dy;

		const color = chooseColor(rng, type); // cbonsai.c:491
		wattron(treeWin, color.pair, color.bold);

		const branchStr = chooseString(rng, conf.leaves, type, life, dx, dy); // cbonsai.c:494

		// cbonsai.c:497-503 — grab the first wide character and refuse to draw
		// where a double-width glyph would land on an odd column.
		const w = wcwidth(branchStr.codePointAt(0));
		const writes = [];
		if (w !== 0 && x % w === 0) {
			mvwprintw(treeWin, y, x, branchStr, writes);
		}

		wattroffBold(treeWin); // cbonsai.c:505

		// One `updateScreen()` per loop iteration in live mode (cbonsai.c:511),
		// so one loop iteration is exactly one frame of growth — including the
		// iterations that drew nothing because the branch was off-window.
		ctx.steps.push(writes);
	}
}

// ---------------------------------------------------------------------------
// Screen assembly
// ---------------------------------------------------------------------------

/**
 * `overlay(src, dst)` — cbonsai.c:1084-1085. Non-destructive: a source cell
 * that is a plain blank is not copied, which is how the spaces inside the base
 * art leave the terminal's default background showing through.
 *
 * @param {Win} src Source window.
 * @param {Win} dst Destination window (stdscr).
 * @returns {void}
 */
function overlay(src, dst) {
	for (let sy = 0; sy < src.rows; sy++) {
		const dy = src.begY + sy - dst.begY;
		if (dy < 0 || dy > dst.maxY) continue;
		for (let sx = 0; sx < src.cols; sx++) {
			const dxp = src.begX + sx - dst.begX;
			if (dxp < 0 || dxp > dst.maxX) continue;
			const si = sy * src.cols + sx;
			// `over` mode: skip cells equal to the window background.
			if (src.ch[si] === BLANK && src.width[si] === 1 && src.pair[si] === 0 && src.bold[si] === 0) {
				continue;
			}
			const di = dy * dst.cols + dxp;
			dst.ch[di] = src.ch[si];
			dst.bold[di] = src.bold[si];
			dst.pair[di] = src.pair[si];
			dst.width[di] = src.width[si];
		}
	}
}

/**
 * `pair_content()` plus cbonsai's colour configuration.
 *
 * Pair 0 is "no pair": with `use_default_colors()` in effect (cbonsai.c:659)
 * `pair_content(0)` reports fg == -1, and `printstdscr()` then formats that
 * with `"\033[3%him"` to produce the famously malformed `ESC[3-1m`. That is
 * cbonsai's output, not a bug in this port, and BRIEF N3 requires it.
 *
 * @param {number} pair The colour pair id.
 * @param {number[]} colors `conf.colors` — [leafDark, woodDark, leafBright, woodBright].
 * @returns {number} The foreground colour index, or -1 for the terminal default.
 */
export function pairForeground(pair, colors) {
	if (pair === 0) return -1;
	if (pair === ColorPair.text) return 8; // init_pair(5, 8, bg) on 256 colours
	return colors[pair - 1];
}

/**
 * A rendered 40x80 screen. Parallel arrays rather than an array of objects, so
 * that a renderer can walk it every animation frame without allocating.
 *
 * All the per-cell arrays are row-major and `rows * cols` long, so cell
 * `(y, x)` is index `y * cols + x` in every one of them. `chars` is the
 * authoritative grid; `lines` is the same thing joined per row for convenience.
 *
 * @typedef {object} BonsaiFrame
 * @property {number} rows Row count (40).
 * @property {number} cols Column count (80).
 * @property {string[]} chars One entry per CELL, `rows * cols` long. As in
 *   ncurses, the second cell of a double-width glyph holds that SAME glyph
 *   rather than a blank.
 * @property {Uint8Array} width 2 for the lead cell of a double-width glyph,
 *   0 for its extension cell, 1 otherwise. With the default `&` leaf every
 *   cell is 1. Note `printstdscr()` ignores this and goes by glyph width.
 * @property {string[]} lines One string per row, walked the way
 *   `printstdscr()` walks it. `cols` DISPLAY columns wide, which is also
 *   `cols` JavaScript characters unless a `-c` list brought in wide glyphs.
 * @property {Uint8Array} bold A_BOLD flag per cell.
 * @property {Uint8Array} pair Colour pair per cell.
 * @property {Int16Array} fg Foreground colour index per cell; -1 = default.
 * @property {number} step How many growth steps were applied.
 * @property {number} stepCount The total number of growth steps.
 * @property {number} t The normalized time this frame was rendered for.
 */

/**
 * The result of growing one tree: an immutable record of every draw, replayable
 * to any point.
 *
 * Instances are cheap to query and never touch a clock, the network, or
 * `Math.random`. `frameAt()` keeps an internal replay cache purely as a speed
 * optimisation; it cannot change what is returned.
 */
export class BonsaiGrowth {
	/**
	 * @param {object} init Internal construction record.
	 */
	constructor(init) {
		/** @type {number} the seed passed to `srand()` */
		this.seed = init.seed;
		/** @type {number} stdscr rows (BRIEF N2: 40) */
		this.rows = init.rows;
		/** @type {number} stdscr cols (BRIEF N2: 80) */
		this.cols = init.cols;
		/** @type {Readonly<object>} the resolved cbonsai configuration */
		this.conf = init.conf;
		/** @type {number} total branches grown — cbonsai's `myCounters.branches` */
		this.branches = init.branches;
		/** @type {number} total shoots grown — cbonsai's `myCounters.shoots` */
		this.shoots = init.shoots;
		/**
		 * One entry per iteration of `branch()`'s while loop, in the order
		 * cbonsai would have called `updateScreen()`. An entry may be empty when
		 * the branch was outside the window.
		 * @type {ReadonlyArray<ReadonlyArray<{y: number, x: number, ch: string, bold: number, pair: number, width: number}>>}
		 */
		this.steps = init.steps;
		/** @type {number} number of growth steps; `t = 1` applies all of them */
		this.stepCount = init.steps.length;
		/** @type {Win} the base-art window, or null for `-b 0` */
		this._baseWin = init.baseWin;

		// Replay cache: a treeWin plus how many steps have been applied to it.
		this._cacheWin = new Win(init.treeRows, init.cols, 0, 0);
		this._cacheApplied = 0;
		// Frame memo. A 3600s run at 60fps asks for ~216000 frames but only
		// ~500 of them differ, so re-composing every time would burn the ASCII
		// panel's whole budget redrawing an identical screen.
		this._frameStep = -1;
		this._frame = null;
	}

	/**
	 * Map normalized time to a step index.
	 *
	 * @param {number} t Normalized time in [0, 1]. Values outside are clamped.
	 * @returns {number} A step index in [0, stepCount].
	 */
	stepForT(t) {
		if (!Number.isFinite(t) || t <= 0) return 0;
		if (t >= 1) return this.stepCount;
		return Math.min(this.stepCount, Math.floor(t * this.stepCount));
	}

	/**
	 * Render the screen as it stands after `step` growth steps.
	 *
	 * The returned frame is owned by this `BonsaiGrowth` and is memoized per
	 * step: treat it as READ-ONLY. Copy `lines` / `bold` / `pair` / `fg` if you
	 * need to keep or modify them.
	 *
	 * @param {number} step How many steps to apply, clamped to [0, stepCount].
	 * @returns {BonsaiFrame} The rendered screen.
	 */
	frameAtStep(step) {
		const n = Math.max(0, Math.min(this.stepCount, Math.trunc(step)));
		if (this._frameStep === n) return this._frame;

		// Replay. Steps only ever add or overwrite cells, so going forward is
		// incremental; going backward needs a fresh window.
		const win = this._cacheWin;
		if (n < this._cacheApplied) {
			win.ch.fill(BLANK);
			win.bold.fill(0);
			win.pair.fill(0);
			win.width.fill(1);
			this._cacheApplied = 0;
		}
		for (let s = this._cacheApplied; s < n; s++) {
			const writes = this.steps[s];
			for (let i = 0; i < writes.length; i++) {
				const wr = writes[i];
				const idx = wr.y * win.cols + wr.x;
				win.ch[idx] = wr.ch;
				win.bold[idx] = wr.bold;
				win.pair[idx] = wr.pair;
				win.width[idx] = wr.width;
			}
		}
		this._cacheApplied = n;

		// cbonsai.c:1083-1087 — overlay base first, then the tree, onto stdscr.
		const scr = new Win(this.rows, this.cols, 0, 0);
		if (this._baseWin) overlay(this._baseWin, scr);
		overlay(win, scr);

		this._frame = this._toFrame(scr, n);
		this._frameStep = n;
		return this._frame;
	}

	/**
	 * Render the screen for a normalized time. THIS is what the clock drives
	 * (BRIEF N6: growth is a pure function of `t`, never of wall-clock).
	 *
	 * The frame's arrays are shared with the per-step memo; treat them as
	 * read-only. Only `t` is per-call.
	 *
	 * @param {number} t Normalized time in [0, 1]. Out-of-range values clamp.
	 * @returns {BonsaiFrame} The rendered screen.
	 */
	frameAt(t) {
		const frame = this.frameAtStep(this.stepForT(t));
		const clamped = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
		// Shallow copy so a caller holding two frames at different `t` in the
		// same step does not see one overwrite the other's time.
		return { ...frame, t: clamped };
	}

	/**
	 * Run to completion — the state cbonsai is in when `printstdscr()` runs.
	 * This is the frame the M1 diff compares against `cbonsai -p -s <seed>`.
	 *
	 * @returns {BonsaiFrame} The fully grown screen.
	 */
	finalFrame() {
		return this.frameAt(1);
	}

	/**
	 * The 40x80 character grid, SGR stripped — byte-identical to the
	 * `seed-<N>.plain.txt` goldens (one trailing newline per row).
	 *
	 * @param {BonsaiFrame} [frame] A frame; defaults to the finished tree.
	 * @returns {string} `rows` lines of `cols` characters.
	 */
	toPlainText(frame) {
		const f = frame || this.finalFrame();
		return f.lines.join('\n') + '\n';
	}

	/**
	 * Reproduce `printstdscr()` (cbonsai.c:719-768) exactly: per-cell SGR then
	 * the character, a newline after the last column of each row, and a final
	 * `ESC[0m` line. Compare this against the raw `seed-<N>.txt` goldens.
	 *
	 * Includes the `ESC[3-1m` quirk for default-coloured cells, and the
	 * wide-glyph skip at cbonsai.c:757-763 (which, note, can swallow a row's
	 * trailing newline when a double-width glyph ends the row).
	 *
	 * @param {BonsaiFrame} [frame] A frame; defaults to the finished tree.
	 * @returns {string} The print-mode byte stream, as a string.
	 */
	toPrintMode(frame) {
		const f = frame || this.finalFrame();
		const out = [];
		const maxX = this.cols;
		for (let y = 0; y < this.rows; y++) {
			for (let x = 0; x < maxX; x++) {
				const idx = y * maxX + x;
				const fg = f.fg[idx];

				out.push(f.bold[idx] ? '\x1b[1m' : '\x1b[0m'); // cbonsai.c:741-742

				// cbonsai.c:745-748
				if (fg === 0) out.push('\x1b[0m');
				else if (fg >= 16) out.push(`\x1b[38;5;${fg}m`);
				else if (fg <= 7) out.push(`\x1b[3${fg}m`); // fg == -1 -> ESC[3-1m
				else out.push(`\x1b[9${fg - 8}m`);

				// Index by CELL, not by position in the joined line: a
				// double-width glyph occupies two cells but one JS character.
				const ch = f.chars[idx];
				out.push(ch); // cbonsai.c:751

				if (x === maxX - 1) out.push('\n'); // cbonsai.c:754-755

				// cbonsai.c:757-763 — skip `cwidth - 1` following cells. This
				// is driven purely by the glyph's own width, with no check for
				// whether the cell was a lead or an extension, and it can
				// swallow the row's newline when a wide glyph ends the row.
				// Both are cbonsai's behaviour, not slips.
				const cwidth = wcwidth(ch.codePointAt(0));
				if (cwidth > 1) x += cwidth - 1;
			}
		}
		out.push('\x1b[0m\n'); // cbonsai.c:767
		return out.join('');
	}

	/**
	 * @param {Win} scr The composed stdscr.
	 * @param {number} step Steps applied.
	 * @returns {BonsaiFrame}
	 */
	_toFrame(scr, step) {
		const n = this.rows * this.cols;
		const lines = new Array(this.rows);
		const chars = new Array(n);
		const fg = new Int16Array(n);
		for (let y = 0; y < this.rows; y++) {
			for (let x = 0; x < this.cols; x++) {
				const idx = y * this.cols + x;
				chars[idx] = scr.ch[idx];
				fg[idx] = pairForeground(scr.pair[idx], this.conf.colors);
			}
			// Build the row the way printstdscr() walks it (cbonsai.c:751-763):
			// print the cell's glyph, then skip wcwidth-1 cells. It does NOT
			// consult the lead/extension flag, so the walk — not the cell count
			// — is what defines the visible row.
			let line = '';
			let x = 0;
			while (x < this.cols) {
				const ch = chars[y * this.cols + x];
				line += ch;
				const cw = ch === '' ? 1 : wcwidth(ch.codePointAt(0));
				x += cw > 1 ? cw : 1;
			}
			lines[y] = line;
		}
		return {
			rows: this.rows,
			cols: this.cols,
			chars,
			width: scr.width,
			lines,
			bold: scr.bold,
			pair: scr.pair,
			fg,
			step,
			stepCount: this.stepCount,
			t: this.stepCount === 0 ? 1 : step / this.stepCount,
		};
	}
}

/**
 * Draw the base art into its own window — `drawBase()` at cbonsai.c:168-205.
 *
 * @param {number} baseType 0, 1 or 2.
 * @param {number} rows stdscr rows.
 * @param {number} cols stdscr cols.
 * @returns {{win: Win|null, height: number, width: number}} The base window.
 */
function makeBaseWin(baseType, rows, cols) {
	const art = BASE_ART[baseType];
	if (!art) return { win: null, height: 0, width: 0 };

	// cbonsai.c:224-226
	const originY = rows - art.height;
	const originX = Math.floor(cols / 2) - Math.floor(art.width / 2);

	const win = new Win(art.height, art.width, originY, originX);
	for (let r = 0; r < art.rows.length; r++) {
		// Row 0 is a chain of wprintw() calls continuing from the cursor; rows
		// 1+ each start with mvwprintw(win, r, 0, ...).
		if (r === 0) wmove(win, 0, 0);
		else wmove(win, r, 0);
		for (const run of art.rows[r]) {
			wattron(win, run.pair, run.bold);
			waddstr(win, run.text, null);
		}
	}
	return { win, height: art.height, width: art.width };
}

/**
 * Grow one bonsai. This is the entry point.
 *
 * Mirrors cbonsai's `main()` -> `srand(seed)` -> `init()` -> `growTree()`
 * (cbonsai.c:1062-1068), with print mode's final overlay and dump available via
 * the returned object.
 *
 * @param {object} [options] Growth options.
 * @param {number} [options.seed=0] The seed handed to `srand()` (cbonsai's `-s`).
 *   cbonsai replaces 0 with `time(NULL)`; here 0 is passed through so the
 *   result stays deterministic, and glibc's own "seed 0 becomes 1" rule applies.
 * @param {number} [options.rows=40] stdscr rows — `LINES`. BRIEF N2.
 * @param {number} [options.cols=80] stdscr cols — `COLUMNS`. BRIEF N2.
 * @param {number} [options.lifeStart=32] cbonsai's `-L`.
 * @param {number} [options.multiplier=5] cbonsai's `-M`.
 * @param {number} [options.baseType=1] cbonsai's `-b`.
 * @param {string[]} [options.leaves=['&']] cbonsai's `-c`, already split on commas.
 * @param {number[]} [options.colors=[2,3,10,11]] cbonsai's `-k`.
 * @returns {BonsaiGrowth} The replayable growth record.
 */
export function growBonsai(options = {}) {
	const seed = options.seed === undefined ? 0 : options.seed;
	const rows = options.rows === undefined ? DEFAULT_ROWS : options.rows;
	const cols = options.cols === undefined ? DEFAULT_COLS : options.cols;

	const conf = Object.freeze({
		lifeStart: options.lifeStart === undefined ? DEFAULT_LIFE_START : options.lifeStart,
		multiplier: options.multiplier === undefined ? DEFAULT_MULTIPLIER : options.multiplier,
		baseType: options.baseType === undefined ? DEFAULT_BASE_TYPE : options.baseType,
		leaves: Object.freeze(
			options.leaves && options.leaves.length ? options.leaves.slice() : DEFAULT_LEAVES.slice(),
		),
		colors: Object.freeze(
			options.colors && options.colors.length === 4
				? options.colors.slice()
				: DEFAULT_COLORS.slice(),
		),
	});

	if (!Number.isInteger(rows) || rows < 1) throw new RangeError(`rows must be a positive integer, got ${rows}`);
	if (!Number.isInteger(cols) || cols < 1) throw new RangeError(`cols must be a positive integer, got ${cols}`);
	// cbonsai's own argument parser rejects `-M 0` and `-L 0` outright
	// (cbonsai.c:927-935, cbonsai.c:937-946), so those values never reach the
	// algorithm and there is no C behaviour to be faithful to. Refusing them
	// here keeps the port's input domain identical to the program's.
	if (!Number.isInteger(conf.multiplier) || conf.multiplier < 1) {
		throw new RangeError(`multiplier must be a positive integer (cbonsai rejects -M 0), got ${conf.multiplier}`);
	}
	if (!Number.isInteger(conf.lifeStart) || conf.lifeStart < 1) {
		throw new RangeError(`lifeStart must be a positive integer (cbonsai rejects -L 0), got ${conf.lifeStart}`);
	}

	// cbonsai.c:1062 — one global stream, seeded once, consumed in order.
	const rng = new GlibcRandom(seed);

	// init() -> drawWins(): the base steals rows from the bottom, and treeWin
	// gets what is left (cbonsai.c:232-233). This is BRIEF N2 in three lines.
	const base = makeBaseWin(conf.baseType, rows, cols);
	const treeRows = rows - base.height;
	const treeWin = new Win(treeRows, cols, 0, 0);

	// drawMessage() is a no-op without `-m`, and creates no windows.

	const ctx = {
		rng,
		conf,
		treeWin,
		counters: {
			shoots: 0, // cbonsai.c:702
			branches: 0, // cbonsai.c:703
			// cbonsai.c:704 — the FIRST draw of the run, before any branching.
			shootCounter: rng.rand() | 0,
		},
		steps: [],
	};

	// cbonsai.c:711 — getmaxyx(treeWin) gives (treeRows, cols); the trunk starts
	// on the bottom row of treeWin, horizontally centred by integer division.
	branch(ctx, treeRows - 1, Math.floor(cols / 2), BranchType.trunk, conf.lifeStart);

	return new BonsaiGrowth({
		seed,
		rows,
		cols,
		treeRows,
		conf,
		baseWin: base.win,
		branches: ctx.counters.branches,
		shoots: ctx.counters.shoots,
		steps: ctx.steps,
	});
}

/**
 * Convenience: the finished 40x80 character grid for a seed, as text.
 * This is the "run to completion" mode — what `cbonsai -p -s <seed>` prints,
 * with SGR stripped, for the M1 diff.
 *
 * @param {number} seed The seed.
 * @param {object} [options] Further {@link growBonsai} options.
 * @returns {string} `rows` lines of `cols` characters, newline-terminated.
 */
export function renderFinalText(seed, options = {}) {
	return growBonsai({ ...options, seed }).toPlainText();
}

/**
 * Convenience: the growth at a normalized time, as text. This is what the clock
 * drives (BRIEF N6).
 *
 * @param {number} seed The seed.
 * @param {number} t Normalized time in [0, 1].
 * @param {object} [options] Further {@link growBonsai} options.
 * @returns {string} `rows` lines of `cols` characters, newline-terminated.
 */
export function renderTextAt(seed, t, options = {}) {
	const growth = growBonsai({ ...options, seed });
	return growth.toPlainText(growth.frameAt(t));
}

export default growBonsai;
