/**
 * panel.js — the Blender plate: the JPEG frame ladder, scrubbed by GrowthClock.
 *
 * This module owns ONE node: `#blender-stage`. It is the right-hand half of the
 * duet and it is driven by exactly the same clock as the ASCII panel
 * (BRIEF N6: growth is a pure function of normalized `t`).
 *
 * ---------------------------------------------------------------------------
 * N4 — the ladder is the ONLY scrub source. There is no <video> here.
 * ---------------------------------------------------------------------------
 * A `<video>` seek snaps to the nearest keyframe, which makes the M3 sync gate
 * measure the codec rather than the growth. Swapping `<img>` frames is exact by
 * construction: frame `i` is `t = i / (frameCount - 1)`, and nothing between us
 * and the pixels is allowed to interpolate, drop or reorder.
 *
 * ---------------------------------------------------------------------------
 * N5 — the crossfade, and why the base layer's opacity is nailed to 1
 * ---------------------------------------------------------------------------
 * Frames are 6 model-seconds apart. Held flat that reads as a slideshow beside
 * a live character grid, so we blend the two nearest: `f = t * (frameCount-1)`,
 * `lo = floor(f)`, `hi = min(lo+1, last)`, blend weight `frac = f - lo`.
 *
 * TWO STACKED `<img>`, OPACITY ONLY. No canvas is redrawn per frame; the
 * compositor does the blend on the GPU and the main thread writes one number.
 *
 * The naive version of this — fade layer A **out** while fading layer B **in** —
 * is wrong, and wrong in a way that is easy to ship without noticing. Compositing
 * `B` (alpha `f`) over `A` (alpha `1-f`) over the plate `P` gives:
 *
 *     out = f*B + (1-f)*(1-f)*A + f*(1-f)*P
 *
 * so a fraction `f*(1-f)` of the **background** leaks through — 25% of it at the
 * midpoint. On this panel `P` is a near-black studio gradient, so every blend
 * would dip ~25% dark halfway and pop back: a visible 6-second strobe for the
 * whole hour, and a double-exposed tree while it happened.
 *
 * What this module does instead: the BASE layer is always fully opaque and the
 * TOP layer carries the whole blend. Both cover the identical rect and JPEG has
 * no alpha, so the plate cannot contribute at all and the composite collapses to
 *
 *     out = (1 - frac)*lo + frac*hi
 *
 * an exact linear interpolation whose mean luminance stays inside the envelope
 * of the two frames it is between. Total coverage is 1 at every value of `frac`.
 *
 * Boundaries are exact, not approximate: `t = 0` puts frame 0 on the base layer
 * with `frac = 0`, and `t = 1` gives `f = 599` exactly, so `lo = hi = last` and
 * the top layer is fully transparent. No off-by-one at either end.
 *
 * ---------------------------------------------------------------------------
 * Loading — 600 files, ~53 MB on disk, and `Cache-Control: no-store`
 * ---------------------------------------------------------------------------
 * Preloading the ladder would mean 600 requests and a stall at boot, so this
 * module runs a SLIDING WINDOW ahead of the playhead, sized from the clock's own
 * speed: at `?speed=1` the playhead crawls and a handful of frames suffice; at
 * `?speed=60` it moves ~10 frames/second and the window opens to cover it.
 *
 * `server.mjs` sends `no-store` on everything (deliberately — agents edit under
 * it constantly), so the HTTP cache cannot be used as the prefetch buffer: a
 * second request for the same URL really does refetch. The window therefore
 * holds the bytes itself, as Blobs behind object URLs. That also makes eviction
 * DETERMINISTIC — `revokeObjectURL` releases the buffer now, not whenever the
 * browser's heuristics feel like it — which is what keeps memory flat across
 * M4's real hour. Compressed frames average ~58 KB, so even a 64-frame window
 * is under 4 MB; decoded bitmaps are 4.3 MB each, so only a couple of frames
 * either side of the playhead are ever held decoded.
 *
 * Decoding happens off the critical path: every layer swap awaits
 * `HTMLImageElement.decode()` while the layer is still transparent, and the
 * opacity is raised only once that resolves. A frame that is late cannot jank a
 * swap and cannot flash — the base layer just keeps holding the last good frame
 * until its replacement is genuinely ready.
 *
 * @module blender/panel
 */

import { parseParams } from '../shared/clock.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Where the ladder lives, relative to the page. Read, never hardcoded past this. */
export const DEFAULT_MANIFEST_URL = 'public/frames/manifest.json';

/**
 * Window and retry policy. Every number is a memory/latency trade and is
 * documented where it is spent.
 */
export const DEFAULTS = Object.freeze({
	/** Seconds of playback the prefetch window tries to stay ahead by. */
	lookaheadSeconds: 3,
	/** Floor on the window, so a paused or ×1 run still has the next few frames. */
	minAhead: 4,
	/** Ceiling on the window. 64 blobs ≈ 3.7 MB — the memory budget, in frames. */
	maxAhead: 64,
	/** Frames kept behind the playhead (cheap insurance against a backward nudge). */
	keepBehind: 2,
	/** In-flight fetches. Matches a browser's per-origin connection limit. */
	maxConcurrent: 6,
	/** Frames held DECODED ahead of the playhead. Each one is ~4.3 MB. */
	decodeAhead: 2,
	/** Retry backoff for a failed fetch: base * 2^attempts, capped. */
	retryBaseMs: 200,
	retryMaxMs: 4000,
	/** After this many consecutive failures a frame is given up on (and skipped). */
	maxAttempts: 8,
	/** No advance for this long while the clock is running ⇒ `data-state="stalled"`. */
	stallMs: 2500,
	/**
	 * N8 — a gap this long between two presents means the PAGE was suspended
	 * (hidden tab, minimised window, laptop lid), not that the network stalled.
	 * A visible run presents every rAF, so ~16 ms; nothing legitimate lands here.
	 * The panel treats it as a seek, not as a fault: re-seat the window on the
	 * new playhead, keep the last good frame on screen, and never say "stalled".
	 */
	resumeGapMs: 700,
	/**
	 * N8 — how long the dissolve lasts when the playhead lands somewhere far from
	 * what is on screen. A promote is normally invisible because the incoming
	 * layer is already at ~1.0 opacity from the crossfade; after a jump it is at
	 * 0, and swapping it in cold is the "visible snap" the M3 gate caught.
	 */
	jumpFadeMs: 240,
	/** Frames of distance that count as a jump rather than a normal step. */
	jumpFadeMinGap: 3,
	/**
	 * How long a layer swap will wait on `decode()` before accepting a merely
	 * LOADED image. Chrome does not settle `decode()` for a hidden tab, and a
	 * plate that never paints because the tab was backgrounded at boot is a far
	 * worse failure than one frame rasterizing during paint. See Layer#show.
	 */
	decodeTimeoutMs: 400,
});

// ---------------------------------------------------------------------------
// Pure helpers — no DOM, no network. Node can import and test these.
// ---------------------------------------------------------------------------

/**
 * Clamp into [0, 1]. NaN becomes 0. (Same contract as the clock's `clamp01`,
 * duplicated rather than imported so this file stays honest about its inputs.)
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
	if (!(value > 0)) return 0;
	if (value >= 1) return 1;
	return value;
}

/**
 * @typedef {object} FramePosition
 * @property {number} position The exact fractional frame, `t * (frameCount - 1)`.
 * @property {number} lo       Base frame index.
 * @property {number} hi       Blend target, `min(lo + 1, frameCount - 1)`.
 * @property {number} frac     Blend weight in [0, 1); the TOP layer's opacity.
 */

/**
 * The exact frame position for a normalized time (N5).
 *
 * Endpoints are exact by construction: `t = 0` → `{lo: 0, hi: 1, frac: 0}` shows
 * frame 0 and nothing else; `t = 1` → `position === frameCount - 1` exactly, so
 * `lo === hi === last` and `frac === 0` shows frame 599 and nothing else. The
 * `lo >= last` branch is what stops `hi` running off the end of the ladder.
 *
 * Interior frame times are exact to within floating point and no further:
 * measured over all 600 of them, `|t*(frameCount-1) - i|` peaks at 5.7e-14, so
 * 29 of them land as `lo = i-1` with `frac = 1 - 5.7e-14`. That composites to
 * frame `i` exactly at 8 bits (the residual weight rounds to 0/255), and the
 * two endpoints the brief actually specifies are bit-exact. Do not "fix" this
 * by rounding `position` — rounding would quantise the crossfade N5 exists for.
 *
 * @param {number} t          Normalized time; clamped to [0, 1].
 * @param {number} frameCount Total frames in the ladder (from the manifest).
 * @returns {FramePosition}
 */
export function frameIndicesForT(t, frameCount) {
	const count = Number.isFinite(frameCount) ? Math.max(1, Math.floor(frameCount)) : 1;
	const last = count - 1;
	const position = clamp01(t) * last;
	const lo = Math.floor(position);
	if (!(lo < last)) return { position: last, lo: last, hi: last, frac: 0 };
	return { position, lo, hi: lo + 1, frac: position - lo };
}

/**
 * How many frames the prefetch window should reach ahead of the playhead.
 *
 * The playhead advances at `(frameCount - 1) * speed / duration` frames per REAL
 * second, so the window is that rate times `lookaheadSeconds`. A compressed
 * `?speed=60` run therefore opens the window ~60× wider than the canonical hour
 * without anyone having to tune a constant per run.
 *
 * @param {{frameCount: number, duration: number, speed: number}} run
 * @param {Partial<typeof DEFAULTS>} [opts]
 * @returns {number} Frames ahead, within [minAhead, maxAhead].
 */
export function prefetchAhead(run, opts = {}) {
	const o = { ...DEFAULTS, ...opts };
	const count = Number.isFinite(run.frameCount) ? Math.max(1, run.frameCount) : 1;
	const duration = Number.isFinite(run.duration) && run.duration > 0 ? run.duration : 3600;
	const speed = Number.isFinite(run.speed) && run.speed > 0 ? run.speed : 1;
	const framesPerRealSecond = ((count - 1) * speed) / duration;
	const ahead = Math.ceil(framesPerRealSecond * o.lookaheadSeconds) + o.minAhead;
	return Math.max(o.minAhead, Math.min(o.maxAhead, ahead));
}

/**
 * Expand a `printf`-style frame pattern (`"frame-%04d.jpg"`).
 * @param {string} pattern
 * @param {number} index
 * @returns {string}
 */
export function formatFrameName(pattern, index) {
	return String(pattern).replace(/%(0(\d+))?d/, (_m, _pad, width) =>
		width ? String(index).padStart(Number(width), '0') : String(index),
	);
}

/**
 * @typedef {object} Ladder
 * @property {number} frameCount
 * @property {number} width
 * @property {number} height
 * @property {string[]} urls    Absolute URL per frame index.
 * @property {number} totalBytes
 * @property {object} manifest  The raw manifest, for anything else that wants it.
 */

/**
 * Normalize `public/frames/manifest.json` into a ladder.
 *
 * The frame count and the `t` mapping come from the manifest — never from a
 * literal 600 in this file — so a re-render with a different count still scrubs
 * correctly. The endpoint claim (`tFirst = 0`, `tLast = 1`) is checked rather
 * than assumed, because every boundary guarantee in this module rests on it.
 *
 * @param {object} raw     Parsed manifest.
 * @param {string|URL} baseUrl Directory the frame files sit in.
 * @returns {Ladder}
 */
export function normalizeManifest(raw, baseUrl) {
	if (!raw || typeof raw !== 'object') throw new TypeError('frame manifest is not an object');
	const list = Array.isArray(raw.frames) ? raw.frames : [];
	const frameCount = Number.isFinite(raw.frameCount) ? raw.frameCount : list.length;
	if (!(frameCount >= 2)) throw new RangeError(`frame manifest has ${frameCount} frames; need >= 2`);
	if (list.length && list.length !== frameCount) {
		throw new RangeError(`manifest frameCount ${frameCount} != frames[] length ${list.length}`);
	}

	const pattern = typeof raw.pattern === 'string' ? raw.pattern : 'frame-%04d.jpg';
	const base = new URL(String(baseUrl), globalThis.document ? document.baseURI : 'http://localhost/');
	const urls = new Array(frameCount);
	for (let i = 0; i < frameCount; i++) {
		const file = list[i] && typeof list[i].file === 'string' ? list[i].file : formatFrameName(pattern, i);
		urls[i] = new URL(file, base).href;
	}

	// The whole of N5's exactness rests on t = index / (frameCount - 1).
	const tFirst = list.length ? list[0].t : raw.tFirst;
	const tLast = list.length ? list[frameCount - 1].t : raw.tLast;
	if (Number.isFinite(tFirst) && Math.abs(tFirst) > 1e-9) {
		throw new RangeError(`manifest frame 0 claims t=${tFirst}; expected exactly 0`);
	}
	if (Number.isFinite(tLast) && Math.abs(tLast - 1) > 1e-9) {
		throw new RangeError(`manifest frame ${frameCount - 1} claims t=${tLast}; expected exactly 1`);
	}

	return {
		frameCount,
		width: Number.isFinite(raw.width) ? raw.width : 0,
		height: Number.isFinite(raw.height) ? raw.height : 0,
		totalBytes: Number.isFinite(raw.totalBytes) ? raw.totalBytes : 0,
		urls,
		manifest: raw,
	};
}

// ---------------------------------------------------------------------------
// FrameCache — the sliding window, in bytes we own
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CacheEntry
 * @property {number} index
 * @property {'pending'|'ready'|'error'} state
 * @property {string|null} objectUrl Blob URL, live only while the entry is held.
 * @property {number} bytes
 * @property {number} attempts
 * @property {number} nextTryAt      Epoch ms before which a retry is pointless.
 * @property {AbortController|null} controller
 * @property {HTMLImageElement|null} decoded Held only inside the decode window.
 */

/**
 * Fetches frames into Blobs, hands out object URLs, and drops them on demand.
 *
 * Nothing here knows about `t` or about layers; it is a window over an array of
 * URLs with a concurrency limit, a retry policy and an explicit `release()`.
 */
export class FrameCache {
	/**
	 * @param {string[]} urls
	 * @param {object} [options]
	 * @param {typeof fetch} [options.fetchImpl]
	 * @param {(f: Blob) => string} [options.createObjectURL]
	 * @param {(u: string) => void} [options.revokeObjectURL]
	 * @param {new () => HTMLImageElement} [options.ImageCtor]
	 * @param {(index: number) => void} [options.onSettled] Called when a frame lands.
	 * @param {Partial<typeof DEFAULTS>} [options.policy]
	 */
	constructor(urls, options = {}) {
		this.urls = urls;
		this.entries = new Map();
		this.inFlight = 0;
		this.policy = { ...DEFAULTS, ...(options.policy || {}) };
		this._fetch = options.fetchImpl || ((...a) => globalThis.fetch(...a));
		this._createUrl = options.createObjectURL || ((b) => URL.createObjectURL(b));
		this._revokeUrl = options.revokeObjectURL || ((u) => URL.revokeObjectURL(u));
		this._Image = options.ImageCtor || globalThis.Image;
		this._onSettled = options.onSettled || (() => {});
		/** Counters the proof scripts read. */
		this.stats = { fetched: 0, failed: 0, evicted: 0, bytes: 0, decodes: 0 };
	}

	/** @param {number} index @returns {CacheEntry|undefined} the entry if usable. */
	ready(index) {
		const e = this.entries.get(index);
		return e && e.state === 'ready' ? e : undefined;
	}

	/** Live blob URL for a frame, or null. @param {number} index @returns {string|null} */
	urlFor(index) {
		const e = this.ready(index);
		return e ? e.objectUrl : null;
	}

	/**
	 * Start fetches for `wanted`, in priority order, up to the concurrency limit.
	 * Idempotent: a frame already held or in flight is skipped.
	 * @param {number[]} wanted Frame indices, most urgent first.
	 */
	request(wanted) {
		const now = Date.now();
		for (const index of wanted) {
			if (this.inFlight >= this.policy.maxConcurrent) return;
			if (index < 0 || index >= this.urls.length) continue;
			const existing = this.entries.get(index);
			if (existing) {
				if (existing.state !== 'error') continue;
				if (existing.attempts >= this.policy.maxAttempts) continue;
				if (now < existing.nextTryAt) continue;
			}
			this._start(index, existing);
		}
	}

	/** @param {number} index @param {CacheEntry} [prev] */
	_start(index, prev) {
		const controller = typeof AbortController === 'function' ? new AbortController() : null;
		/** @type {CacheEntry} */
		const entry = {
			index,
			state: 'pending',
			objectUrl: null,
			bytes: 0,
			attempts: prev ? prev.attempts : 0,
			nextTryAt: 0,
			controller,
			decoded: null,
			settled: false,
		};
		this.entries.set(index, entry);
		this.inFlight += 1;

		this._fetch(this.urls[index], {
			signal: controller ? controller.signal : undefined,
			// The bytes are the buffer; the HTTP cache is `no-store` here anyway.
			cache: 'no-store',
			credentials: 'omit',
		})
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status} for frame ${index}`);
				return res.blob();
			})
			.then((blob) => {
				this._settle(entry);
				// Evicted while in flight: the entry is gone, so is its claim on memory.
				if (this.entries.get(index) !== entry) return;
				entry.state = 'ready';
				entry.bytes = blob.size;
				entry.objectUrl = this._createUrl(blob);
				entry.attempts = 0;
				entry.controller = null;
				this.stats.fetched += 1;
				this.stats.bytes += blob.size;
				this._onSettled(index);
			})
			.catch((err) => {
				this._settle(entry);
				if (this.entries.get(index) !== entry) return;
				if (err && err.name === 'AbortError') {
					this.entries.delete(index);
					return;
				}
				entry.state = 'error';
				entry.controller = null;
				entry.attempts += 1;
				const backoff = Math.min(
					this.policy.retryMaxMs,
					this.policy.retryBaseMs * 2 ** (entry.attempts - 1),
				);
				entry.nextTryAt = Date.now() + backoff;
				this.stats.failed += 1;
				// A slow or missing frame is NOT a blank panel: the caller simply keeps
				// holding the frame it already has. See BlenderPanel#_present.
				this._onSettled(index);
			});
	}

	/**
	 * Release a request's claim on the concurrency budget, exactly once.
	 *
	 * Called from the success path, the failure path AND from `_release()` when a
	 * pending fetch is aborted. The last of those is what makes N8 recovery fast:
	 * when the window is re-seated after a backgrounded tab, up to
	 * `maxConcurrent` fetches for the OLD window are aborted, and their slots have
	 * to be free in the same task or `request([lo])` sees a full pipe and declines
	 * to start the one frame the playhead is actually waiting for. Aborts settle
	 * asynchronously, so the counter cannot wait for them.
	 *
	 * (It also closes a latent double-decrement: a throw inside the blob handler
	 * would previously run the catch handler and subtract twice.)
	 *
	 * @param {CacheEntry} entry
	 */
	_settle(entry) {
		if (!entry || entry.settled) return;
		entry.settled = true;
		this.inFlight -= 1;
	}

	/**
	 * Decode a held frame ahead of time so a layer swap never waits on the CPU.
	 * The decoded bitmap is ~4.3 MB, which is why only `decodeAhead` of them exist.
	 * @param {number} index
	 */
	prime(index) {
		const entry = this.ready(index);
		if (!entry || entry.decoded || !this._Image) return;
		const img = new this._Image();
		entry.decoded = img;
		img.decoding = 'async';
		img.src = entry.objectUrl;
		if (typeof img.decode === 'function') {
			img.decode().then(
				() => {
					this.stats.decodes += 1;
				},
				() => {},
			);
		}
	}

	/**
	 * Throw away a held frame the renderer could not display (a truncated or
	 * corrupt blob) and schedule a refetch behind the normal backoff, so a bad
	 * frame costs one retry rather than a 60 Hz retry loop.
	 * @param {number} index
	 */
	invalidate(index) {
		const entry = this.entries.get(index);
		if (!entry) return;
		const attempts = entry.attempts + 1;
		this._release(index, entry);
		this.entries.set(index, {
			index,
			state: 'error',
			objectUrl: null,
			bytes: 0,
			attempts,
			nextTryAt:
				Date.now() + Math.min(this.policy.retryMaxMs, this.policy.retryBaseMs * 2 ** (attempts - 1)),
			controller: null,
			decoded: null,
			settled: true,
		});
	}

	/** Drop the decoded bitmap but keep the compressed bytes. @param {number} index */
	unprime(index) {
		const entry = this.entries.get(index);
		if (entry && entry.decoded) {
			entry.decoded.src = '';
			entry.decoded = null;
		}
	}

	/**
	 * Keep only `[first, last]` plus `protectedIndices`; release everything else.
	 * This is the whole memory story: run it every tick and the heap is a window,
	 * not a log.
	 * @param {number} first
	 * @param {number} last
	 * @param {Iterable<number>} [protectedIndices] Indices a layer is displaying.
	 */
	keep(first, last, protectedIndices = []) {
		const keepSet = new Set();
		for (const i of protectedIndices) if (Number.isInteger(i)) keepSet.add(i);
		for (const [index, entry] of this.entries) {
			if ((index >= first && index <= last) || keepSet.has(index)) continue;
			this._release(index, entry);
		}
	}

	/** @param {number} index @param {CacheEntry} entry */
	_release(index, entry) {
		if (entry.controller) entry.controller.abort();
		if (entry.state === 'pending') this._settle(entry);
		if (entry.decoded) {
			entry.decoded.src = '';
			entry.decoded = null;
		}
		if (entry.objectUrl) {
			this._revokeUrl(entry.objectUrl);
			this.stats.bytes -= entry.bytes;
			this.stats.evicted += 1;
		}
		this.entries.delete(index);
	}

	/** Release everything. @returns {void} */
	clear() {
		for (const [index, entry] of [...this.entries]) this._release(index, entry);
	}

	/** Held frames, ready or not. @returns {number} */
	get size() {
		return this.entries.size;
	}

	/** Compressed bytes currently held. @returns {number} */
	get heldBytes() {
		let total = 0;
		for (const entry of this.entries.values()) total += entry.bytes;
		return total;
	}
}

// ---------------------------------------------------------------------------
// Layer — one <img> in the stack
// ---------------------------------------------------------------------------

/** @typedef {'ready'|'failed'|'superseded'} ShowResult */

/**
 * One of the two stacked images. A layer never reveals a frame it has not
 * finished decoding: `show()` sets `src` while the element is transparent,
 * awaits `decode()`, and only then reports itself ready to be faded up.
 */
class Layer {
	/**
	 * @param {HTMLImageElement} el
	 * @param {number} [decodeTimeoutMs]
	 */
	constructor(el, decodeTimeoutMs = DEFAULTS.decodeTimeoutMs) {
		this.el = el;
		/** @type {number|null} */
		this.index = null;
		this.ready = false;
		this._token = 0;
		this._decodeTimeoutMs = decodeTimeoutMs;
		/** @type {Promise<ShowResult>|null} In-flight show(), so a repeat call joins it. */
		this._pending = null;
		/** @type {(() => void)|null} Cancels the in-flight load's listeners. */
		this._abort = null;
		/** Last opacity written, so a 60Hz tick that changes nothing writes nothing. */
		this._opacity = el.style.opacity || '0';
		this._z = null;
	}

	/**
	 * Point this layer at a frame.
	 *
	 * Safe to call repeatedly: a call for the index already in flight joins that
	 * promise instead of re-assigning `src` (re-assigning the same URL fires no
	 * second `load`, which would hang the swap forever), and a superseded call
	 * resolves `false` and touches nothing — the token keeps a slow decode from
	 * landing after the playhead has moved on.
	 *
	 * Readiness is the `load` event, not `decode()`. `decode()` is the
	 * optimization that keeps rasterization off the critical path, and it is
	 * awaited — but with a cap, because Chrome leaves the promise unsettled while
	 * the tab is hidden and a plate that can never paint is the worse bug.
	 *
	 * SUPERSEDED IS NOT FAILED. One `<img>` serves every frame this layer shows,
	 * so the `load` that fires after a re-point belongs to the NEW src — the
	 * previous call's listeners would otherwise see it and report success (or,
	 * after the token check, failure) for a frame that was simply overtaken. That
	 * misreading is expensive: it condemns a perfectly good cached frame. Hence
	 * the three-valued result, and hence `_abort()` detaching the old listeners.
	 *
	 * @param {number} index
	 * @param {string} url Blob URL.
	 * @returns {Promise<ShowResult>} 'ready' | 'failed' | 'superseded'
	 */
	show(index, url) {
		if (this.index === index && this.ready) return Promise.resolve('ready');
		if (this.index === index && this._pending) return this._pending;
		if (this._abort) this._abort(); // the previous load is overtaken, not broken
		const token = ++this._token;
		this.index = index;
		this.ready = false;
		const el = this.el;

		// Transparent BEFORE the src changes: a loading image must never be
		// visible, or the swap flashes. Both writes land in the same task, so no
		// paint can happen between them.
		this.setOpacity(0);

		const pending = (async () => {
			/** @type {boolean|null} true = loaded, false = errored, null = superseded */
			const outcome = await new Promise((resolve) => {
				const detach = () => {
					el.removeEventListener('load', onLoad);
					el.removeEventListener('error', onError);
					if (this._abort === abort) this._abort = null;
				};
				const onLoad = () => {
					detach();
					resolve(true);
				};
				const onError = () => {
					detach();
					resolve(false);
				};
				const abort = () => {
					detach();
					resolve(null);
				};
				this._abort = abort;
				el.addEventListener('load', onLoad);
				el.addEventListener('error', onError);
				el.src = url;
				// A blob URL can complete synchronously; the listeners would then
				// never fire, so check after assigning rather than before.
				if (el.complete && el.naturalWidth > 0) onLoad();
			});

			if (outcome === null || token !== this._token) return 'superseded';
			if (outcome === true && typeof el.decode === 'function') {
				await Promise.race([
					el.decode().then(
						() => true,
						() => true,
					),
					new Promise((r) => setTimeout(r, this._decodeTimeoutMs)),
				]);
			}
			if (token !== this._token) return 'superseded';
			this._pending = null;
			this.ready = outcome === true && el.complete && el.naturalWidth > 0;
			if (this.ready) return 'ready';
			// A blob that will not decode. Forget it completely — index AND src —
			// so that a refetched replacement is a genuinely new assignment and
			// therefore fires `load` again. The layer is transparent throughout, so
			// nothing on screen changed while this failed.
			this.index = null;
			el.removeAttribute('src');
			return 'failed';
		})();

		this._pending = pending;
		return pending;
	}

	/** @param {number} value */
	setOpacity(value) {
		const next = value <= 0 ? '0' : value >= 1 ? '1' : value.toFixed(4);
		if (this._opacity !== next) {
			this._opacity = next;
			this.el.style.opacity = next;
		}
	}

	/** @param {number} z */
	setZ(z) {
		if (this._z !== z) {
			this._z = z;
			this.el.style.zIndex = String(z);
		}
	}
}

// ---------------------------------------------------------------------------
// BlenderPanel
// ---------------------------------------------------------------------------

/**
 * The right-hand panel: two crossfading images over the JPEG ladder.
 */
export class BlenderPanel {
	/**
	 * @param {HTMLElement} stage The `#blender-stage` node.
	 * @param {Ladder} ladder
	 * @param {object} [options]
	 * @param {number} [options.duration] Model seconds (window sizing only).
	 * @param {number} [options.speed]    Speed multiplier (window sizing only).
	 * @param {Partial<typeof DEFAULTS>} [options.policy]
	 * @param {FrameCache} [options.cache] Injected cache (tests).
	 */
	constructor(stage, ladder, options = {}) {
		this.stage = stage;
		this.ladder = ladder;
		this.policy = { ...DEFAULTS, ...(options.policy || {}) };
		this.duration = Number.isFinite(options.duration) && options.duration > 0 ? options.duration : 3600;
		this.speed = Number.isFinite(options.speed) && options.speed > 0 ? options.speed : 1;

		/** Frames the window reaches ahead — a function of the clock's speed. */
		this.ahead = prefetchAhead(
			{ frameCount: ladder.frameCount, duration: this.duration, speed: this.speed },
			this.policy,
		);

		this._lastT = 0;
		this._presented = { position: 0, lo: -1, hi: -1, frac: 0 };
		this._lastAdvanceAt = Date.now();
		this._state = '';
		this._painted = false;
		this._destroyed = false;
		this._pumping = false;

		/* --- N8: recovery from a suspended page -------------------------------
		   `_lastPresentAt` is the heartbeat. A visible run presents every rAF, so
		   any gap larger than `resumeGapMs` means the page was not running — the
		   tab was hidden, the window minimised, the machine asleep. The clock
		   kept tracking WALL time throughout (deliberately: coming back after 20
		   minutes must show 20 minutes of growth), so the playhead is now far from
		   what is on screen and this panel has to seek, not complain.
		   `_recovering` says we are mid-seek: it re-prioritises the fetch queue
		   onto the single frame the playhead needs and suppresses the stall
		   indicator, which measures network health and knows nothing about a tab
		   that simply was not being painted. */
		this._lastPresentAt = Date.now();
		this._recovering = false;
		/** @type {{index: number, timer: any}|null} An in-flight jump dissolve. */
		this._fade = null;
		/** Set when a clock is attached, so `resync()` can ask it for `t` itself. */
		this._clock = null;
		this._resyncCount = 0;
		this._recoveryStartedAt = 0;
		this._lastResyncMs = 0;

		const doc = stage.ownerDocument || globalThis.document;
		this._doc = doc;

		this.cache =
			options.cache ||
			new FrameCache(ladder.urls, {
				policy: this.policy,
				// A frame landing is a reason to re-present even when the clock is
				// silent — which it is, permanently, after t = 1.
				onSettled: () => this._present(),
			});

		this._buildDom();
		this._setState('loading');
		this._present();

		// N8. Two independent triggers, because neither alone is sufficient:
		// `visibilitychange` fires BEFORE the first restored rAF, so the refetch
		// starts a frame earlier than the clock could ask for it; the gap
		// detector in `_present()` catches everything visibility does not report
		// (minimised windows, occluded tabs, a sleeping machine, bfcache).
		this._onVisible = () => {
			if (this._doc.visibilityState === 'visible') this.resync();
		};
		if (typeof doc.addEventListener === 'function') {
			doc.addEventListener('visibilitychange', this._onVisible);
			const view = doc.defaultView;
			if (view && typeof view.addEventListener === 'function') {
				view.addEventListener('pageshow', this._onVisible);
				this._view = view;
			}
		}
	}

	// --- DOM -----------------------------------------------------------------

	_buildDom() {
		const doc = this._doc;
		const stage = this.stage;

		// The shell's stand-in, and the note under it, belong to the placeholder.
		const placeholder = stage.querySelector('.stage-placeholder');
		if (placeholder) placeholder.remove();
		const note = doc.querySelector('[data-placeholder-note="blender"]');
		if (note && note.remove) note.remove();

		/** @param {number} z */
		const makeLayer = (z) => {
			const img = doc.createElement('img');
			img.alt = '';
			img.decoding = 'async';
			img.draggable = false;
			img.className = 'plate-layer';
			img.dataset.layer = z === 0 ? 'base' : 'top';
			// Inline, not in styles.css — another agent owns that file, and these
			// five declarations are load-bearing for the blend rather than cosmetic:
			// identical rect, no alpha gap, opacity promoted to its own GPU layer.
			Object.assign(img.style, {
				position: 'absolute',
				inset: '0',
				width: '100%',
				height: '100%',
				objectFit: 'contain',
				display: 'block',
				opacity: '0',
				zIndex: String(z),
				willChange: 'opacity',
				pointerEvents: 'none',
				userSelect: 'none',
			});
			stage.appendChild(img);
			return new Layer(img, this.policy.decodeTimeoutMs);
		};

		this._base = makeLayer(0);
		this._top = makeLayer(1);
		this._base.setZ(0);
		this._top.setZ(1);

		// Our own loading card, styled inline so this module does not depend on
		// a rule in a file it does not own. Removed on the first painted frame.
		const loading = doc.createElement('div');
		loading.className = 'plate-loading';
		Object.assign(loading.style, {
			position: 'relative',
			zIndex: '2',
			fontSize: '10px',
			letterSpacing: '0.2em',
			textTransform: 'uppercase',
			color: 'var(--hud-dim, #4c5a53)',
			textAlign: 'center',
			pointerEvents: 'none',
		});
		loading.textContent = 'loading plate';
		stage.appendChild(loading);
		this._loading = loading;

		// The shell hands the node over on this attribute (index.html contract).
		if (stage.dataset) {
			delete stage.dataset.placeholder;
			stage.dataset.frames = String(this.ladder.frameCount);
			stage.dataset.ahead = String(this.ahead);
		} else if (stage.removeAttribute) {
			stage.removeAttribute('data-placeholder');
		}

		// The plate's own framing numbers, published for whoever aligns the two
		// panels (BRIEF, "M3 composition note"). Additive: nothing here reads them.
		const cam = this.ladder.manifest && this.ladder.manifest.camera;
		if (cam && typeof cam === 'object') {
			for (const [key, value] of Object.entries(cam)) {
				if (typeof value === 'number') stage.style.setProperty(`--plate-${key.replace(/_/g, '-')}`, String(value));
			}
		}
		if (this.ladder.width && this.ladder.height) {
			stage.style.setProperty('--plate-aspect', `${this.ladder.width} / ${this.ladder.height}`);
		}
	}

	/** @param {string} state */
	_setState(state) {
		if (this._state === state) return;
		this._state = state;
		if (this.stage.dataset) this.stage.dataset.state = state;
	}

	// --- scrubbing -----------------------------------------------------------

	/**
	 * Subscribe to a GrowthClock. The clock cancels its own loop at `t = 1`,
	 * which is how this panel "holds at full bloom and stops".
	 * @param {{subscribe: (cb: (f: {t: number}) => void) => (() => void)}} clock
	 * @returns {() => void} unsubscribe
	 */
	attach(clock) {
		this.useClock(clock);
		const off = clock.subscribe((frame) => this.seek(frame.t));
		return typeof off === 'function' ? off : () => {};
	}

	/**
	 * Remember the clock so `resync()` can read `t` from it directly.
	 *
	 * On `visibilitychange` the panel must not wait to be told where the playhead
	 * is — the whole point is to start fetching the right frame before the first
	 * restored animation frame runs. Optional: with no clock the panel simply
	 * re-seats on the last `t` it was handed, and the shell's own tick corrects it
	 * a moment later.
	 *
	 * @param {{sample?: () => {t: number}, frame?: {t: number}}|null} clock
	 * @returns {this}
	 */
	useClock(clock) {
		this._clock = clock && (typeof clock.sample === 'function' || clock.frame) ? clock : null;
		return this;
	}

	/** Normalized time straight from the clock, or the last one we were given. */
	_clockT() {
		const clock = this._clock;
		if (!clock) return this._lastT;
		try {
			const frame = typeof clock.sample === 'function' ? clock.sample() : clock.frame;
			if (frame && Number.isFinite(frame.t)) return clamp01(frame.t);
		} catch {
			/* a clock that throws is not worth a blank panel */
		}
		return this._lastT;
	}

	/**
	 * N8 — the page just came back. Recompute `t`, re-seat the prefetch window on
	 * the new playhead, and hold the frame already on screen until the correct one
	 * has decoded.
	 *
	 * Idempotent and safe to call from anywhere: the shell calls it via the clock
	 * (a synchronous `tick()` on `visibilitychange`), this panel calls it from its
	 * own listener, and `_present()` calls it when it notices a gap. Whichever
	 * arrives first does the work; the others are no-ops.
	 *
	 * @param {number} [t] Normalized time. Omitted: ask the clock.
	 * @returns {FramePosition}
	 */
	resync(t) {
		if (this._destroyed) return this._presented;
		const now = Date.now();
		const next = Number.isFinite(t) ? clamp01(t) : this._clockT();
		// The clock never runs backwards and neither does the ladder.
		if (next > this._lastT) this._lastT = next;
		this._beginRecovery(now);
		this._lastPresentAt = now; // we are handling the gap; do not re-detect it
		return this._present();
	}

	/**
	 * Enter recovery. Nothing here touches the screen: what is on it is the last
	 * good frame and it stays there until a better one has decoded.
	 * @param {number} now
	 */
	_beginRecovery(now) {
		// A suspended tab is not a stalled network. Restart the stall window so
		// the twenty minutes nobody was painting cannot be mistaken for a fault.
		this._lastAdvanceAt = now;
		if (this._recovering) return;
		this._recovering = true;
		this._recoveryStartedAt = now;
		this._resyncCount += 1;
		if (this._painted) this._setState('resyncing');
	}

	/** Leave recovery once the playhead's own frame is the one on screen. */
	_endRecovery() {
		if (!this._recovering) return;
		this._recovering = false;
		this._lastResyncMs = Date.now() - this._recoveryStartedAt;
	}

	/**
	 * Scrub to a normalized time. Cheap and idempotent: the overwhelming majority
	 * of ticks resolve to the same frame pair and only write one opacity.
	 * @param {number} t
	 * @returns {FramePosition} What is on screen after this call.
	 */
	seek(t) {
		this._lastT = clamp01(t);
		return this._present();
	}

	/**
	 * Reconcile the two layers with `this._lastT`.
	 *
	 * Invariant, checked by M3: the BASE layer is opaque and shows `lo`; the TOP
	 * layer shows `hi` at opacity `frac`. Anything that cannot be satisfied yet
	 * (a frame still fetching or decoding) leaves the previous state untouched —
	 * holding is always preferable to flashing.
	 *
	 * @returns {FramePosition}
	 */
	_present() {
		if (this._destroyed) return this._presented;

		// N8 heartbeat. A visible page presents every rAF; a gap this large means
		// the page was suspended and the clock ran on without us. Treat it as a
		// seek — re-seat the window, keep holding what is on screen — rather than
		// as the network fault the stall timer would otherwise call it.
		const now = Date.now();
		if (this._painted && now - this._lastPresentAt > this.policy.resumeGapMs) {
			this._beginRecovery(now);
		}
		this._lastPresentAt = now;

		const pos = frameIndicesForT(this._lastT, this.ladder.frameCount);
		const { lo, hi, frac } = pos;

		// Keep the window centred on the playhead before anything else, so the
		// frames this pass needs are the ones being fetched.
		this._pump(lo, hi);

		// A jump dissolve is running. Let it finish — the layers are mid-transition
		// and writing opacity now would be exactly the snap the dissolve exists to
		// prevent — unless the playhead has already left the frame being revealed,
		// in which case land it immediately and reconcile against the real `lo`.
		if (this._fade) {
			if (lo === this._fade.index || lo === this._fade.index + 1) return this._presented;
			this._finishFade();
		}

		if (this._base.index !== lo) {
			if (this._top.index === lo && this._top.ready) {
				// N8. The incoming layer is cold (a jump landed on it) and far from
				// what is on screen: swapping it in cold IS the visible snap. Dissolve
				// instead. A normal forward step never gets here — its top layer is
				// already at ~1.0 opacity from the crossfade, so the promote below is
				// invisible by construction.
				if (this._shouldFade(lo)) {
					this._startFade(lo);
					return this._presented;
				}
				// The normal forward step: last tick's `hi` is this tick's `lo`, already
				// decoded and already at ~1.0 opacity. Promote it. Both style writes and
				// the pointer swap happen in this one task, so no paint sees a gap. This
				// is also how the very first frame arrives — staged, decoded, promoted.
				this._promote();
			} else {
				// A jump, or nothing shown yet. Stage `lo` on the TOP layer, which is
				// transparent, so the base keeps holding the last good frame meanwhile;
				// `_present()` runs again when the decode resolves, and promotes.
				this._freeStagingLayer(lo);
				const url = this.cache.urlFor(lo);
				if (url && this._top.index !== lo) {
					this._top.show(lo, url).then((ok) => this._afterShow(lo, ok));
				}
				// Cannot show `lo` yet. Hold. Never blank, never flash.
				this._holdCheck();
				return this._presented;
			}
		}

		// The base layer now shows `lo` at opacity 1. Point the top layer at `hi`.
		// At t = 1, `hi === lo`: there is nothing to blend toward, so the top layer
		// simply stays transparent and frame `last` is on screen unmixed.
		const top = this._top;
		if (hi !== lo && top.index !== hi) {
			const url = this.cache.urlFor(hi);
			if (url) {
				top.show(hi, url).then((ok) => this._afterShow(hi, ok));
			} else {
				// `hi` is not here yet. Show `lo` alone rather than blending toward a
				// frame we do not have — a hard cut to the correct base beats a ghost.
				top.setOpacity(0);
			}
		}
		// The ONE number this panel writes per tick. Base stays at 1 (N5).
		top.setOpacity(hi !== lo && top.index === hi && top.ready ? frac : 0);

		this._markPainted();
		if (this._presented.lo !== lo || this._presented.hi !== hi) this._lastAdvanceAt = Date.now();
		this._presented = pos;
		// Reaching here means the base layer is showing the playhead's own frame,
		// which is the definition of "recovered".
		this._endRecovery();
		this._setState(this._lastT >= 1 ? 'held' : 'ready');
		return pos;
	}

	/**
	 * A layer finished (or failed) loading a frame. Either way, re-present: the
	 * clock is silent after t = 1, so an arriving frame has to drive itself onto
	 * the screen.
	 * A 'superseded' result is left alone: the show() that overtook it is the one
	 * that will drive the next present, and the frame it was carrying is still
	 * perfectly good.
	 *
	 * @param {number} index
	 * @param {ShowResult} result
	 */
	_afterShow(index, result) {
		if (this._destroyed || result === 'superseded') return;
		if (result === 'failed') this.cache.invalidate(index);
		this._present();
	}

	/**
	 * Swap the layer roles: the top layer (already decoded, already nearly opaque)
	 * becomes the opaque base, and the old base becomes the transparent staging
	 * layer for the next frame.
	 */
	_promote() {
		const oldBase = this._base;
		const oldTop = this._top;

		oldTop.setOpacity(1);
		oldTop.setZ(0);
		oldBase.setOpacity(0);
		oldBase.setZ(1);
		oldBase.el.dataset.layer = 'top';
		oldTop.el.dataset.layer = 'base';

		this._base = oldTop;
		this._top = oldBase;
	}

	/**
	 * N8 — would promoting `lo` be a visible snap?
	 *
	 * The normal forward step promotes a layer that the crossfade has already
	 * carried to ~1.0 opacity, so the swap changes nothing on screen. After a
	 * jump the incoming layer is at 0 and its frame is minutes of growth away
	 * from the one being held: that promote is a cut. Dissolve those instead.
	 *
	 * @param {number} lo
	 * @returns {boolean}
	 */
	_shouldFade(lo) {
		if (!this._painted || !(this.policy.jumpFadeMs > 0)) return false;
		if (this._base.index === null || !this._base.ready) return false;
		if (Math.abs(lo - this._base.index) < this.policy.jumpFadeMinGap) return false;
		return Number(this._top.el.style.opacity || 0) < 0.5;
	}

	/**
	 * Dissolve the (already decoded) top layer up over the frame being held.
	 *
	 * The base stays at opacity 1 underneath for the whole transition, so the
	 * N5 compositing rule still holds and no background leaks through the blend.
	 *
	 * @param {number} index
	 */
	_startFade(index) {
		const layer = this._top;
		const el = layer.el;
		const ms = this.policy.jumpFadeMs;
		// Commit the current opacity before arming the transition. Without this
		// the 0 and the 1 can land in the same style recalculation and there is
		// nothing left to animate between — a cut wearing a transition.
		const view = this._doc.defaultView;
		if (view && typeof view.getComputedStyle === 'function') {
			void view.getComputedStyle(el).opacity;
		}
		el.style.transition = `opacity ${ms}ms linear`;
		layer.setOpacity(1);
		this._fade = {
			index,
			// Driven by a timer, not `transitionend`: a transition that never fires
			// (reduced motion, a compositor that drops it) must still land the frame.
			timer: setTimeout(() => {
				this._finishFade();
				this._present();
			}, ms + 60),
		};
	}

	/** Land the dissolve: the revealed layer becomes the opaque base. */
	_finishFade() {
		const fade = this._fade;
		if (!fade) return;
		this._fade = null;
		if (fade.timer) clearTimeout(fade.timer);
		const layer = this._top;
		layer.el.style.transition = '';
		if (layer.index === fade.index && layer.ready) {
			layer.setOpacity(1);
			this._promote();
		} else {
			// Superseded mid-dissolve. The base never stopped holding a good frame.
			layer.setOpacity(0);
		}
	}

	/**
	 * Make the top layer safe to stage into, without a visible step.
	 *
	 * A page suspended mid-crossfade leaves the top layer part-way up. Pointing it
	 * at a new frame sets its opacity to 0, which subtracts that partial blend in
	 * one go. When it is more than half up, promoting it is both the smaller
	 * visible change AND a move toward the playhead, so prefer that.
	 *
	 * @param {number} lo The frame about to be staged.
	 */
	_freeStagingLayer(lo) {
		const top = this._top;
		if (top.index === null || top.index === lo || !top.ready) return;
		if (top.index > lo) return; // never walk the ladder backwards
		if (Number(top.el.style.opacity || 0) >= 0.5) this._promote();
	}

	_markPainted() {
		if (this._painted || !this._base.ready) return;
		this._painted = true;
		if (this._loading) {
			this._loading.remove();
			this._loading = null;
		}
	}

	/** Nothing advanced; decide whether that is merely slow or actually stalled. */
	_holdCheck() {
		if (!this._painted) {
			this._setState('loading');
			return;
		}
		// N8. Coming back from a suspended page is a SEEK, not a fault: the frame
		// on screen is correct for where the playhead was, the right one is already
		// the only thing being fetched, and calling that "stalled" both misreports
		// the panel and was the visible symptom the M3 gate caught.
		if (this._recovering) {
			this._setState('resyncing');
			return;
		}
		if (Date.now() - this._lastAdvanceAt > this.policy.stallMs) this._setState('stalled');
	}

	/**
	 * Move the prefetch window, evict behind it, and keep a couple of frames
	 * decoded ahead. Called every present; all of it is O(window).
	 * @param {number} lo
	 * @param {number} hi
	 */
	_pump(lo, hi) {
		if (this._pumping) return;
		this._pumping = true;
		try {
			const last = this.ladder.frameCount - 1;
			const first = Math.max(0, lo - this.policy.keepBehind);
			const end = Math.min(last, lo + this.ahead);

			const held = [this._base.index, this._top.index].filter((i) => Number.isInteger(i));
			// Re-seating the window on the new playhead is this one call: everything
			// outside it is released and any fetch still in flight for it is aborted,
			// which is what frees the connection budget for the frame below.
			this.cache.keep(first, end, held);

			// N8. Mid-recovery the playhead is sitting on a frame we do not have, and
			// the ONLY thing that matters is that one frame — refilling the rest of
			// the window first would put five other requests ahead of it on a
			// six-connection budget and pay for them with the hold time the viewer
			// actually sees. Fetch it alone, decode it alone, refill afterwards.
			const urgent = this._recovering && !this.cache.ready(lo);
			const wanted = urgent ? [lo] : [lo, hi];
			if (!urgent) for (let i = lo + 1; i <= end; i++) if (i !== hi) wanted.push(i);
			this.cache.request(wanted);

			// Decoded bitmaps are 4.3 MB apiece — keep the window on those tight.
			const decodeEnd = urgent ? lo : Math.min(last, lo + this.policy.decodeAhead);
			for (let i = lo; i <= decodeEnd; i++) this.cache.prime(i);
			for (const index of this.cache.entries.keys()) {
				if (index < lo || index > decodeEnd) this.cache.unprime(index);
			}
		} finally {
			this._pumping = false;
		}
	}

	// --- introspection (the proof scripts read this) -------------------------

	/**
	 * @returns {{t: number, position: number, lo: number, hi: number, frac: number,
	 *   baseIndex: number|null, topIndex: number|null, baseOpacity: number,
	 *   topOpacity: number, state: string, held: number, heldBytes: number,
	 *   ahead: number, frameCount: number, stats: object}}
	 */
	stats() {
		return {
			t: this._lastT,
			position: this._presented.position,
			lo: this._presented.lo,
			hi: this._presented.hi,
			frac: this._presented.frac,
			baseIndex: this._base.index,
			topIndex: this._top.index,
			baseOpacity: Number(this._base.el.style.opacity || '0'),
			topOpacity: Number(this._top.el.style.opacity || '0'),
			baseSrc: this._base.index === null ? null : this.ladder.urls[this._base.index],
			topSrc: this._top.index === null ? null : this.ladder.urls[this._top.index],
			state: this._state,
			// N8 instrumentation — the M4 backgrounding proof reads these.
			recovering: this._recovering,
			fading: this._fade !== null,
			resyncCount: this._resyncCount,
			lastResyncMs: this._lastResyncMs,
			held: this.cache.size,
			heldBytes: this.cache.heldBytes,
			ahead: this.ahead,
			frameCount: this.ladder.frameCount,
			stats: { ...this.cache.stats },
		};
	}

	/** Release every frame and stop touching the DOM. @returns {void} */
	destroy() {
		this._destroyed = true;
		if (this._fade && this._fade.timer) clearTimeout(this._fade.timer);
		this._fade = null;
		if (this._onVisible) {
			this._doc.removeEventListener('visibilitychange', this._onVisible);
			if (this._view) this._view.removeEventListener('pageshow', this._onVisible);
			this._onVisible = null;
		}
		for (const layer of [this._base, this._top]) {
			if (layer._abort) layer._abort(); // detach load listeners before the revokes
			layer.el.remove();
		}
		this.cache.clear();
		if (this._loading) this._loading.remove();
	}
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PanelHandle
 * @property {BlenderPanel} panel
 * @property {Ladder} ladder
 * @property {() => void} stop Unsubscribe from the clock (idempotent).
 */

/**
 * Take over `#blender-stage`, load the manifest, and follow the clock.
 *
 * Clock resolution mirrors `src/ascii/terminal.js`, so both panels boot the same
 * way whatever the shell has published by the time the module runs:
 *   1. `options.clock`, 2. `window.BonsaiDuet.clock`,
 *   3. the `bonsai:ready` event, 4. the `bonsai:tick` event bus.
 *
 * @param {object} [options]
 * @param {HTMLElement} [options.element]
 * @param {Document} [options.document]
 * @param {string} [options.manifestUrl]
 * @param {object} [options.clock]
 * @param {{duration?: number, speed?: number}} [options.params]
 * @param {Partial<typeof DEFAULTS>} [options.policy]
 * @returns {Promise<PanelHandle>}
 */
export async function mountBlenderPanel(options = {}) {
	const doc = options.document || globalThis.document;
	if (!doc) throw new Error('mountBlenderPanel(): no document — this is a browser module');

	const element = options.element || doc.getElementById('blender-stage');
	if (!element) throw new Error('mountBlenderPanel(): no #blender-stage to render into');

	const view = doc.defaultView || globalThis.window || globalThis;
	const duet = options.duet || view.BonsaiDuet;
	const params = options.params || (duet && duet.params) || parseParams(view.location);

	const manifestUrl = new URL(options.manifestUrl || DEFAULT_MANIFEST_URL, doc.baseURI);
	const res = await fetch(manifestUrl.href, { cache: 'no-store' });
	if (!res.ok) throw new Error(`frame manifest: HTTP ${res.status} for ${manifestUrl.href}`);
	const ladder = normalizeManifest(await res.json(), manifestUrl);

	// The render's own framing numbers (pot rim / canopy top in normalized frame
	// coordinates) live beside the ladder. Optional: the panel scrubs fine without
	// them, but whoever aligns the two trees (BRIEF, "M3 composition note") needs
	// measured values rather than eyeballed ones, so publish them if present.
	try {
		const camRes = await fetch(new URL('camera.json', manifestUrl).href, { cache: 'no-store' });
		if (camRes.ok) ladder.manifest.camera = await camRes.json();
	} catch {
		/* decorative metadata — never fatal */
	}

	const clock = options.clock || (duet && duet.clock);
	const panel = new BlenderPanel(element, ladder, {
		// Window sizing only. `t` still comes from the clock and nothing else.
		duration: (clock && clock.duration) || params.duration,
		speed: (clock && clock.speed) || params.speed,
		policy: options.policy,
	});

	/** @type {() => void} */
	let unsubscribe = () => {};
	const onFrame = (frame) => panel.seek(frame.t);

	const attach = (candidate) => {
		if (!candidate || typeof candidate.subscribe !== 'function') return false;
		// N8: the panel keeps its own reference so that `visibilitychange` can ask
		// the clock where the playhead is without waiting for the next frame.
		panel.useClock(candidate);
		const off = candidate.subscribe(onFrame);
		unsubscribe = () => {
			if (typeof off === 'function') off();
		};
		return true;
	};

	if (!attach(clock)) {
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
		panel,
		ladder,
		stop() {
			unsubscribe();
			unsubscribe = () => {};
		},
	};
}

/**
 * Self-boot when loaded as a page script. Idempotent: a second import, or a
 * stray second `<script>` tag, returns the promise the first one made.
 *
 * @returns {Promise<PanelHandle>|null} null outside a browser.
 */
export function bootBlenderPanel() {
	const doc = globalThis.document;
	if (!doc) return null;
	const view = doc.defaultView || globalThis.window || globalThis;
	if (view.BonsaiPlatePromise) return view.BonsaiPlatePromise;

	const start = () => {
		const promise = mountBlenderPanel().then((handle) => {
			view.BonsaiPlate = handle; // QA and the proof scripts read this
			return handle;
		});
		promise.catch((err) => {
			// A failed plate must not take the page down with it: the ASCII panel and
			// the timeline keep running, and the stage says why in the DOM.
			console.error('[bonsai-duet] blender panel failed to mount:', err);
			const stage = doc.getElementById('blender-stage');
			if (stage && stage.dataset) {
				stage.dataset.state = 'error';
				stage.dataset.error = String((err && err.message) || err);
			}
		});
		view.BonsaiPlatePromise = promise;
		return promise;
	};

	if (doc.readyState === 'loading') {
		const promise = new Promise((resolve, reject) => {
			doc.addEventListener('DOMContentLoaded', () => start().then(resolve, reject), { once: true });
		});
		view.BonsaiPlatePromise = promise;
		return promise;
	}
	return start();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
	bootBlenderPanel();
}

export default mountBlenderPanel;
