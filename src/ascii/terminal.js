/**
 * terminal.js — the 80x40 `<pre id="tree">` renderer (BRIEF N2).
 *
 * This module owns ONE node: `#tree`. It turns the frames produced by
 * `src/ascii/bonsai.js` into coloured cells, and it is driven by `GrowthClock`
 * and nothing else (BRIEF N6: growth is a pure function of normalized `t`).
 *
 * Three properties are load-bearing, in descending order of how easy they are
 * to break:
 *
 *  1. GROWTH IS MONOTONIC, BECAUSE IT IS A REPLAY.
 *     The tree is grown exactly ONCE, at mount, by `growBonsai()`. What `t`
 *     selects is how many of that single run's recorded draw steps have been
 *     applied — never a new tree, never a new seed, never a re-roll. A branch
 *     drawn at `t` is still drawn at `t + dt` because the step index only ever
 *     advances (`stepForT()` is non-decreasing in `t`, and {@link
 *     TerminalRenderer} additionally floors the index at the highest one it has
 *     already painted). Nothing here can flicker, snap back, or re-seed.
 *
 *  2. THE PALETTE IS cbonsai'S, PER CELL.
 *     `chooseColor()` (cbonsai.c:267-286) attaches a colour pair plus an
 *     optional `A_BOLD` to every glyph: wood-bright+bold or wood-dark for
 *     trunk and shoots, leaf-bright (+bold 1-in-10) for `dying`, leaf-dark
 *     (+bold 1-in-3) for `dead`, and COLOR_TEXT for the pot. `bonsai.js` keeps
 *     that per cell in `frame.pair` / `frame.bold`, which this file maps onto
 *     the class names `src/styles.css` already defines — `leaf-dark`,
 *     `wood-dark`, `leaf-bright`, `wood-bright`, `txt`, plus `b` for bold.
 *     Those CSS tokens are the canonical xterm renderings of cbonsai's default
 *     `-k 2,3,10,11`, so the browser paints what the golden capture encodes.
 *     A non-default `-k` is honoured too, via {@link applyPalette}.
 *
 *  3. IT DOES NOT THRASH THE DOM.
 *     The `<pre>` holds exactly `rows` stable row spans, created once. A frame
 *     is composed as a STRING and only the rows whose markup actually changed
 *     are written back. Above that sits the cheapest guard of all: a run has a
 *     few hundred growth steps, so at 60fps the overwhelming majority of ticks
 *     resolve to the same step index and return after one comparison, having
 *     touched neither the DOM nor the heap. Nothing allocates per cell, and
 *     3200 nodes are never created — not once, let alone per frame.
 *
 * Usage, from the page shell:
 *
 *     <script type="module" src="src/ascii/terminal.js"></script>
 *
 * The module boots itself against `window.BonsaiDuet` (or, if the shell has not
 * published it yet, the `bonsai:ready` event). Tests and proof scripts should
 * import {@link mountTerminal}, {@link TerminalRenderer} or the pure
 * {@link frameHtml} / {@link rowHtml} helpers instead.
 *
 * @module ascii/terminal
 */

import {
	DEFAULT_COLORS,
	DEFAULT_COLS,
	DEFAULT_ROWS,
	growBonsai,
	wcwidth,
} from './bonsai.js';
import { parseParams } from '../shared/clock.js';

// ---------------------------------------------------------------------------
// Cell -> CSS class
// ---------------------------------------------------------------------------

/**
 * ncurses colour pair -> the class name `src/styles.css` colours.
 * Index is the pair id from `cbonsai.c:17-21`; pair 0 ("no pair", foreground
 * -1, the terminal default) deliberately has no class, so blank cells emit
 * bare text and no span at all.
 * @type {ReadonlyArray<string>}
 */
export const PAIR_CLASS = Object.freeze([
	'', // 0 — no pair
	'leaf-dark', // 1 — COLOR_LEAF_DARK,   conf.colors[0], default xterm 2
	'wood-dark', // 2 — COLOR_WOOD_DARK,   conf.colors[1], default xterm 3
	'leaf-bright', // 3 — COLOR_LEAF_BRIGHT, conf.colors[2], default xterm 10
	'wood-bright', // 4 — COLOR_WOOD_BRIGHT, conf.colors[3], default xterm 11
	'txt', // 5 — COLOR_TEXT,        always xterm 8 (cbonsai.c:686)
]);

/** The custom properties `src/styles.css` reads, indexed by colour pair. */
const PAIR_VAR = Object.freeze(['', '--cb-leaf-dark', '--cb-wood-dark', '--cb-leaf-bright', '--cb-wood-bright']);

/**
 * `pair * 2 + bold` -> the exact `class="..."` value. Twelve short strings,
 * built once, so composing a frame never concatenates a class name.
 * @type {ReadonlyArray<string>}
 */
const CLASS_LUT = Object.freeze(
	(() => {
		const lut = [];
		for (let pair = 0; pair < PAIR_CLASS.length; pair++) {
			const name = PAIR_CLASS[pair];
			lut[pair * 2] = name;
			lut[pair * 2 + 1] = name ? `b ${name}` : 'b';
		}
		return lut;
	})(),
);

/**
 * The class list for one cell.
 *
 * @param {number} pair The ncurses colour pair (0-5).
 * @param {number} bold The `A_BOLD` flag (0 or 1).
 * @returns {string} A class attribute value; `''` means "emit no span".
 */
export function cellClass(pair, bold) {
	const cls = CLASS_LUT[pair * 2 + (bold ? 1 : 0)];
	return cls === undefined ? '' : cls;
}

// ---------------------------------------------------------------------------
// HTML composition — pure, DOM-free, and therefore testable in Node
// ---------------------------------------------------------------------------

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Escape a run of cell text for `innerHTML`. `&` is cbonsai's DEFAULT LEAF
 * (cbonsai.c:857), so this is not a theoretical concern: the busiest glyph in
 * the whole tree is the one that must be escaped.
 *
 * Attribute quoting is not a consideration — nothing user-supplied reaches an
 * attribute here; class names come from the frozen {@link CLASS_LUT}.
 *
 * @param {string} text A run of characters.
 * @returns {string} The same run, HTML-safe.
 */
export function escapeText(text) {
	if (text.indexOf('&') === -1 && text.indexOf('<') === -1 && text.indexOf('>') === -1) {
		return text;
	}
	return text.replace(/[&<>]/g, (c) => ENTITIES[c]);
}

/**
 * Compose one row of a {@link import('./bonsai.js').BonsaiFrame} as HTML,
 * coalescing neighbouring cells that share (pair, bold) into a single span.
 * A full 80-column row of tree is typically a dozen or two spans, and an empty
 * row is one text node.
 *
 * The walk is the same one `printstdscr()` performs (cbonsai.c:751-763) and
 * that `bonsai.js` uses to build `frame.lines`: print the cell's glyph, then
 * skip `wcwidth - 1` cells. That is what keeps the rendered row identical to
 * the row the M1 golden diff gates on.
 *
 * @param {import('./bonsai.js').BonsaiFrame} frame The frame to read.
 * @param {number} y The row index.
 * @returns {string} HTML for that row, exactly `frame.cols` display columns wide.
 */
export function rowHtml(frame, y) {
	const cols = frame.cols;
	const base = y * cols;
	const { chars, pair, bold } = frame;

	let html = '';
	let runClass = null;
	let runText = '';

	for (let x = 0; x < cols; ) {
		const idx = base + x;
		const ch = chars[idx];
		const cls = cellClass(pair[idx], bold[idx]);

		if (cls !== runClass) {
			if (runText) html += runClass ? `<span class="${runClass}">${escapeText(runText)}</span>` : escapeText(runText);
			runClass = cls;
			runText = '';
		}
		runText += ch;

		// Double-width glyphs occupy two cells but one character, exactly as in
		// printstdscr(); the continuation cell must not be emitted twice.
		const cw = ch ? wcwidth(ch.codePointAt(0)) : 1;
		x += cw > 1 ? cw : 1;
	}

	if (runText) html += runClass ? `<span class="${runClass}">${escapeText(runText)}</span>` : escapeText(runText);
	return html;
}

/**
 * The whole frame as HTML: `rows` rows separated by newlines, which is what a
 * bare `<pre>` needs to lay out as `rows` lines. Used by proof scripts and by
 * {@link TerminalRenderer} only as a fallback; the renderer's hot path writes
 * rows individually.
 *
 * @param {import('./bonsai.js').BonsaiFrame} frame The frame to read.
 * @returns {string} HTML for the complete grid, no trailing newline.
 */
export function frameHtml(frame) {
	const out = new Array(frame.rows);
	for (let y = 0; y < frame.rows; y++) out[y] = rowHtml(frame, y);
	return out.join('\n');
}

// ---------------------------------------------------------------------------
// xterm-256 palette, for a non-default `-k`
// ---------------------------------------------------------------------------

/** The 16 system colours, as xterm renders them. Indices 0-15. */
const ANSI_16 = Object.freeze([
	'#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
	'#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
]);

const CUBE = Object.freeze([0, 95, 135, 175, 215, 255]);

function hex2(n) {
	return n.toString(16).padStart(2, '0');
}

/**
 * An xterm-256 colour index as `#rrggbb` — the 16 system colours, the 6x6x6
 * cube, then the 24-step greyscale ramp.
 *
 * @param {number} index A colour index in [0, 255].
 * @returns {string} A CSS hex colour.
 */
export function xterm256Hex(index) {
	const i = Math.max(0, Math.min(255, Math.trunc(index)));
	if (i < 16) return ANSI_16[i];
	if (i < 232) {
		const n = i - 16;
		return `#${hex2(CUBE[Math.floor(n / 36) % 6])}${hex2(CUBE[Math.floor(n / 6) % 6])}${hex2(CUBE[n % 6])}`;
	}
	const v = 8 + (i - 232) * 10;
	return `#${hex2(v)}${hex2(v)}${hex2(v)}`;
}

/**
 * The `A_BOLD` rendering of a colour index, following the relationship the
 * default tokens in `src/styles.css` encode: a bold DARK colour (index < 8) is
 * lifted toward its bright twin — xterm 2 `#008000` becomes `#00c000`, i.e.
 * each channel x1.5 — while a bold BRIGHT colour is mixed toward white, which
 * turns xterm 10 `#00ff00` into `#9cff9c`. Both reproduce the shipped tokens.
 *
 * @param {number} index A colour index in [0, 255].
 * @returns {string} A CSS hex colour.
 */
export function boldHex(index) {
	const hex = xterm256Hex(index);
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	const lift =
		index < 8
			? (c) => Math.min(255, Math.round(c * 1.5))
			: (c) => Math.round(c + (255 - c) * 0.61);
	return `#${hex2(lift(r))}${hex2(lift(g))}${hex2(lift(b))}`;
}

/**
 * Point the stylesheet's cbonsai tokens at a non-default `-k` palette.
 *
 * The default `2,3,10,11` case writes NOTHING: `src/styles.css` already carries
 * the canonical xterm values for those indices, and they are the ones the M1
 * palette check is written against. Only a caller that actually changed
 * `colors` moves them, and then only on the `<pre>` itself, so the page's own
 * tokens are left intact.
 *
 * @param {HTMLElement} element The `<pre>`.
 * @param {ReadonlyArray<number>} colors `conf.colors` — [leafDark, woodDark, leafBright, woodBright].
 * @returns {boolean} Whether any custom property was set.
 */
export function applyPalette(element, colors) {
	if (!element || !element.style || !colors || colors.length !== 4) return false;
	let custom = false;
	for (let i = 0; i < 4; i++) {
		if (colors[i] !== DEFAULT_COLORS[i]) custom = true;
	}
	if (!custom) return false;

	for (let i = 0; i < 4; i++) {
		const pair = i + 1;
		element.style.setProperty(PAIR_VAR[pair], xterm256Hex(colors[i]));
		element.style.setProperty(`${PAIR_VAR[pair]}-bold`, boldHex(colors[i]));
	}
	return true;
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/**
 * Paints one {@link import('./bonsai.js').BonsaiGrowth} into one `<pre>`.
 *
 * The constructor grows the tree once and builds the row spans once. After
 * that the only DOM writes are `innerHTML` on the handful of rows a growth
 * step actually changed.
 */
export class TerminalRenderer {
	/**
	 * @param {HTMLElement} element The `<pre id="tree">` to own.
	 * @param {object} [options] Options.
	 * @param {number} [options.seed=42] cbonsai's `-s`. Ignored if `growth` is given.
	 * @param {number} [options.rows=40] BRIEF N2. Must stay 40 for the gate.
	 * @param {number} [options.cols=80] BRIEF N2. Must stay 80 for the gate.
	 * @param {import('./bonsai.js').BonsaiGrowth} [options.growth] A pre-grown
	 *   tree, if the caller already has one (proof scripts reuse theirs).
	 * @param {boolean} [options.monotonic=true] Refuse to paint a step lower
	 *   than the highest already painted, so a clock that restarts or a stray
	 *   backwards `t` can never un-grow the tree.
	 * @param {object} [options.growOptions] Further {@link growBonsai} options
	 *   (`lifeStart`, `multiplier`, `baseType`, `leaves`, `colors`).
	 */
	constructor(element, options = {}) {
		if (!element) throw new TypeError('TerminalRenderer(element): element is required');

		const rows = options.rows === undefined ? DEFAULT_ROWS : options.rows;
		const cols = options.cols === undefined ? DEFAULT_COLS : options.cols;

		/** @type {HTMLElement} */
		this.element = element;
		/** @type {import('./bonsai.js').BonsaiGrowth} the ONE tree, grown once */
		this.growth =
			options.growth ||
			growBonsai({
				...(options.growOptions || {}),
				seed: options.seed === undefined ? 42 : options.seed,
				rows,
				cols,
			});
		/** @type {number} BRIEF N2 */
		this.rows = this.growth.rows;
		/** @type {number} BRIEF N2 */
		this.cols = this.growth.cols;
		/** @type {boolean} */
		this.monotonic = options.monotonic !== false;

		// N2 is an input to the algorithm, not a preference. A renderer pointed
		// at a differently-sized grid would silently invalidate the golden diff,
		// so say so rather than draw something plausible.
		if (this.rows !== DEFAULT_ROWS || this.cols !== DEFAULT_COLS) {
			const doc = element.ownerDocument;
			const warn = doc && doc.defaultView && doc.defaultView.console;
			(warn || console).warn(
				`terminal.js: grid is ${this.cols}x${this.rows}, not ${DEFAULT_COLS}x${DEFAULT_ROWS} (BRIEF N2).`,
			);
		}

		/** @type {number} the step index currently on screen; -1 = nothing yet */
		this._step = -1;
		/** @type {string[]} last markup written per row, to skip unchanged rows */
		this._rowCache = new Array(this.rows).fill(null);
		/** @type {HTMLElement[]} the stable row spans */
		this._rowEls = new Array(this.rows);
		/** @type {string[]} scratch buffer for `text()`; never reallocated */
		this._scratch = new Array(this.rows);

		this._buildDom();
		applyPalette(element, this.growth.conf.colors);
	}

	/** Total growth steps in this run. @returns {number} */
	get stepCount() {
		return this.growth.stepCount;
	}

	/** The step index currently painted. @returns {number} */
	get step() {
		return this._step < 0 ? 0 : this._step;
	}

	/**
	 * Paint the tree as it stands after `step` growth steps.
	 *
	 * @param {number} step Step index; clamped to [0, stepCount], and to
	 *   [lastPainted, ...] when `monotonic`.
	 * @returns {boolean} true if the DOM was touched, false if the screen was
	 *   already correct — which is the answer for most ticks.
	 */
	renderStep(step) {
		let n = Math.max(0, Math.min(this.stepCount, Math.trunc(step)));
		if (this.monotonic && n < this._step) n = this._step;
		if (n === this._step) return false; // the 60fps fast path: no DOM, no alloc

		const frame = this.growth.frameAtStep(n);
		const cache = this._rowCache;
		const els = this._rowEls;
		for (let y = 0; y < this.rows; y++) {
			const html = rowHtml(frame, y);
			if (html === cache[y]) continue; // this row did not change
			cache[y] = html;
			els[y].innerHTML = html;
		}

		this._step = n;
		const ds = this.element.dataset;
		if (ds) {
			ds.step = String(n);
			ds.steps = String(this.stepCount);
		}
		return true;
	}

	/**
	 * Paint the tree for a normalized time. THIS is what the clock drives
	 * (BRIEF N6). `stepForT()` is `floor(t * stepCount)`, so it is
	 * non-decreasing in `t` and the growth it selects is monotonic by
	 * construction.
	 *
	 * @param {number} t Normalized time in [0, 1]; out-of-range values clamp.
	 * @returns {boolean} Whether the DOM was touched.
	 */
	renderAt(t) {
		return this.renderStep(this.growth.stepForT(t));
	}

	/**
	 * Paint from a `GrowthClock` frame. Only `frame.t` is read — never
	 * `elapsed`, never a wall clock, never a frame counter (BRIEF N6).
	 *
	 * @param {{t: number}} frame A clock frame.
	 * @returns {boolean} Whether the DOM was touched.
	 */
	renderFrame(frame) {
		return this.renderAt(frame && typeof frame.t === 'number' ? frame.t : 0);
	}

	/** Paint the finished tree — the state `cbonsai -p` dumps. @returns {boolean} */
	renderFinal() {
		return this.renderStep(this.stepCount);
	}

	/**
	 * The painted grid as plain text: `rows` lines of `cols` characters, the
	 * same string the M1 diff compares against `seed-<N>.plain.txt`. Reads the
	 * DOM, so it is proof rather than prediction.
	 *
	 * @returns {string} The grid, newline-separated, no trailing newline.
	 */
	text() {
		const out = this._scratch;
		for (let y = 0; y < this.rows; y++) out[y] = this._rowEls[y].textContent;
		return out.join('\n');
	}

	/**
	 * Drop the row spans and hand the element back. The clock subscription is
	 * owned by {@link mountTerminal}, not by this class.
	 * @returns {void}
	 */
	destroy() {
		this.element.textContent = '';
		this._rowEls = [];
		this._rowCache = [];
		this._step = -1;
	}

	/**
	 * Create the `rows` row spans plus the newlines between them — the only
	 * node creation this module ever does. `rows` spans and `rows - 1` text
	 * nodes, for a 40-row grid: 79 nodes, once, for the life of the page.
	 * @returns {void}
	 */
	_buildDom() {
		const el = this.element;
		const doc = el.ownerDocument || globalThis.document;
		const frag = doc.createDocumentFragment();

		for (let y = 0; y < this.rows; y++) {
			const span = doc.createElement('span');
			span.className = 'ln';
			this._rowEls[y] = span;
			frag.appendChild(span);
			// The line break lives BETWEEN rows, as its own text node, so a row's
			// innerHTML is purely that row's cells and `textContent` per row is
			// exactly `cols` characters.
			if (y < this.rows - 1) frag.appendChild(doc.createTextNode('\n'));
		}

		el.textContent = '';
		el.appendChild(frag);

		// The shell hands the node over on this attribute (index.html, the
		// INTEGRATION CONTRACT comment). Once it is gone the shell writes nothing.
		if (el.dataset) {
			delete el.dataset.placeholder;
			el.dataset.seed = String(this.growth.seed);
			el.dataset.cols = String(this.cols);
			el.dataset.rows = String(this.rows);
		} else if (el.removeAttribute) {
			el.removeAttribute('data-placeholder');
		}
	}
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TerminalHandle
 * @property {TerminalRenderer} renderer The renderer.
 * @property {import('./bonsai.js').BonsaiGrowth} growth The single grown tree.
 * @property {() => void} stop Unsubscribe from the clock (idempotent).
 */

/**
 * Take over `#tree` and follow the clock.
 *
 * Resolution order for the clock, so the module works whatever the shell has
 * managed to publish by the time it runs:
 *   1. `options.clock`,
 *   2. `window.BonsaiDuet.clock`,
 *   3. the `bonsai:ready` event (the shell dispatches it right after boot),
 *   4. the `bonsai:tick` event, for a page that only has the event bus.
 *
 * The seed comes from the same place the shell got it: `BonsaiDuet.params`,
 * else `parseParams()` on the query string (BRIEF N6, `?seed=`).
 *
 * @param {object} [options] Options; everything {@link TerminalRenderer} takes,
 *   plus `clock`, `params`, `element`, `document`, `duet`.
 * @returns {TerminalHandle} The mounted panel.
 */
export function mountTerminal(options = {}) {
	const doc = options.document || globalThis.document;
	if (!doc) throw new Error('mountTerminal(): no document — this is a browser module');

	const element = options.element || doc.getElementById('tree');
	if (!element) throw new Error('mountTerminal(): no <pre id="tree"> to render into');

	const view = doc.defaultView || globalThis.window || globalThis;
	const duet = options.duet || view.BonsaiDuet;
	const params = options.params || (duet && duet.params) || parseParams(view.location);
	const seed = options.seed === undefined ? params.seed : options.seed;

	const renderer = new TerminalRenderer(element, { ...options, seed });
	renderer.renderStep(0); // t = 0 is a seed: the pot, and nothing grown yet

	// The placeholder note under the panel belongs to the shell's stand-in.
	const note = doc.querySelector('[data-placeholder-note="ascii"]');
	if (note && note.remove) note.remove();

	/** @type {() => void} */
	let unsubscribe = () => {};
	const onFrame = (frame) => renderer.renderFrame(frame);

	const attach = (clock) => {
		if (!clock || typeof clock.subscribe !== 'function') return false;
		// subscribe() fires immediately with the current frame and stops itself
		// at t = 1 — which is how this panel "holds at full bloom and stops".
		const off = clock.subscribe(onFrame);
		unsubscribe = () => {
			if (typeof off === 'function') off();
		};
		return true;
	};

	if (!attach(options.clock || (duet && duet.clock))) {
		const onTick = (ev) => onFrame(ev.detail);
		const onReady = (ev) => {
			view.removeEventListener('bonsai:tick', onTick);
			if (!attach(ev.detail && ev.detail.clock)) view.addEventListener('bonsai:tick', onTick);
		};
		view.addEventListener('bonsai:ready', onReady, { once: true });
		view.addEventListener('bonsai:tick', onTick);
		unsubscribe = () => {
			view.removeEventListener('bonsai:ready', onReady);
			view.removeEventListener('bonsai:tick', onTick);
		};
	}

	return {
		renderer,
		growth: renderer.growth,
		stop() {
			unsubscribe();
			unsubscribe = () => {};
		},
	};
}

/**
 * Self-boot when loaded as a page script. Idempotent: a second import, or a
 * stray second `<script>` tag, returns the handle the first one made.
 *
 * @returns {TerminalHandle|null} The handle, or null outside a browser.
 */
export function bootTerminal() {
	const doc = globalThis.document;
	if (!doc) return null;
	const view = doc.defaultView || globalThis.window || globalThis;
	if (view.BonsaiTerminal) return view.BonsaiTerminal;

	const start = () => {
		if (view.BonsaiTerminal) return view.BonsaiTerminal;
		if (!doc.getElementById('tree')) return null;
		const handle = mountTerminal();
		view.BonsaiTerminal = handle; // QA and the proof scripts read this
		return handle;
	};

	if (doc.readyState === 'loading') {
		doc.addEventListener('DOMContentLoaded', start, { once: true });
		return null;
	}
	return start();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
	bootTerminal();
}

export default mountTerminal;
