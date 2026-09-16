/**
 * GrowthClock — the single source of truth for normalized time `t` in [0, 1].
 *
 * Contract (docs/BRIEF.md, N6):
 *   - URL parameters: ?duration=<seconds>&speed=<multiplier>&seed=<int>
 *     Defaults: duration=3600, speed=1, seed=42.
 *   - `t` is CLAMPED to [0, 1]. It never loops, wraps, or exceeds 1. When it
 *     reaches 1 the clock STOPS: the rAF loop is cancelled and never rescheduled.
 *   - The time source is injectable, so tests drive the clock with zero real
 *     time passing and get bit-identical results.
 *   - Growth logic (ASCII panel, Blender panel) must be a pure function of the
 *     frame handed to it. Nothing downstream may read a wall clock.
 *
 * Both panels read this module. Nothing else owns time.
 *
 * @module shared/clock
 */

/** Parameter defaults from the brief. */
export const DEFAULTS = Object.freeze({ duration: 3600, speed: 1, seed: 42 });

/**
 * Blossoms emerge over the final ~8 minutes of a canonical 3600s run
 * (BRIEF.md, "Architecture"). Expressed in normalized time so that a
 * compressed 60-second QA run blooms at the same `t`.
 */
export const BLOOM_START = 1 - 480 / 3600; // 0.8666666666666667

/**
 * Named phases, in order, as normalized-time spans. `start` is inclusive,
 * `end` exclusive (the final phase includes t = 1).
 */
export const PHASES = Object.freeze([
  Object.freeze({ name: 'seed', start: 0, end: 0.08 }),
  Object.freeze({ name: 'sapling', start: 0.08, end: 0.28 }),
  Object.freeze({ name: 'branching', start: 0.28, end: 0.62 }),
  Object.freeze({ name: 'mature', start: 0.62, end: BLOOM_START }),
  Object.freeze({ name: 'bloom', start: BLOOM_START, end: 1 }),
]);

/** @typedef {'seed'|'sapling'|'branching'|'mature'|'bloom'} PhaseName */

/**
 * @typedef {object} GrowthFrame
 * @property {number}    t             Normalized time, exactly within [0, 1].
 * @property {number}    elapsed       Model seconds elapsed (t * duration), clamped.
 * @property {number}    remaining     Model seconds left (duration - elapsed).
 * @property {number}    duration      Configured duration in model seconds.
 * @property {number}    speed         Configured speed multiplier.
 * @property {number}    seed          Configured integer seed.
 * @property {PhaseName} phase         Named phase for this `t`.
 * @property {number}    phaseIndex    Index of that phase in PHASES.
 * @property {number}    phaseProgress Progress within the phase, [0, 1].
 * @property {boolean}   done          True once t === 1 (the clock has stopped).
 * @property {number}    realElapsed   Real (unscaled) seconds since start.
 */

// ---------------------------------------------------------------------------
// Pure helpers — no time source, no DOM. Safe to import from Node.
// ---------------------------------------------------------------------------

/**
 * Clamp a number into [0, 1]. NaN becomes 0.
 * @param {number} value
 * @returns {number}
 */
export function clamp01(value) {
  if (!(value > 0)) return 0; // also catches NaN and -0
  if (value >= 1) return 1;
  return value;
}

/**
 * Normalized time from elapsed model seconds. Exact at the endpoints:
 * 0 at 0, 1 at (and past) `duration`.
 *
 * @param {number} elapsedSeconds Model seconds elapsed (already speed-scaled).
 * @param {number} [duration]     Model seconds for a full run.
 * @returns {number} t in [0, 1]
 */
export function normalizedTime(elapsedSeconds, duration = DEFAULTS.duration) {
  if (!Number.isFinite(duration) || !(duration > 0)) return 1;
  return clamp01(elapsedSeconds / duration);
}

/**
 * Phase descriptor for a normalized time.
 * @param {number} t
 * @returns {{name: PhaseName, index: number, start: number, end: number, progress: number}}
 */
export function phaseInfoAt(t) {
  const clamped = clamp01(t);
  let index = 0;
  for (let i = PHASES.length - 1; i >= 0; i -= 1) {
    if (clamped >= PHASES[i].start) {
      index = i;
      break;
    }
  }
  const phase = PHASES[index];
  const span = phase.end - phase.start;
  const progress = span > 0 ? clamp01((clamped - phase.start) / span) : 1;
  return {
    name: /** @type {PhaseName} */ (phase.name),
    index,
    start: phase.start,
    end: phase.end,
    progress,
  };
}

/**
 * Named phase for a normalized time.
 * @param {number} t
 * @returns {PhaseName}
 */
export function phaseAt(t) {
  return phaseInfoAt(t).name;
}

/**
 * Build an immutable frame from normalized time plus configuration.
 * Pure: identical inputs always produce an identical frame.
 *
 * @param {number} t
 * @param {{duration?: number, speed?: number, seed?: number, realElapsed?: number}} [config]
 * @returns {GrowthFrame}
 */
export function frameFromT(t, config = {}) {
  const duration = positiveOr(config.duration, DEFAULTS.duration);
  const speed = positiveOr(config.speed, DEFAULTS.speed);
  const seed = integerOr(config.seed, DEFAULTS.seed);
  const clamped = clamp01(t);
  const elapsed = clamped * duration;
  const info = phaseInfoAt(clamped);
  return Object.freeze({
    t: clamped,
    elapsed,
    remaining: duration - elapsed,
    duration,
    speed,
    seed,
    phase: info.name,
    phaseIndex: info.index,
    phaseProgress: info.progress,
    done: clamped >= 1,
    realElapsed: Number.isFinite(config.realElapsed) ? config.realElapsed : elapsed / speed,
  });
}

// ---------------------------------------------------------------------------
// URL parameter parsing (N6)
// ---------------------------------------------------------------------------

/**
 * Coerce assorted inputs into URLSearchParams.
 * Accepts: undefined/null (uses globalThis.location), a query string,
 * a URL or Location-like object, URLSearchParams, or a plain object.
 * @param {*} source
 * @returns {URLSearchParams}
 */
function toSearchParams(source) {
  if (source === undefined || source === null) {
    const loc = globalThis.location;
    return new URLSearchParams(loc && typeof loc.search === 'string' ? loc.search : '');
  }
  if (source instanceof URLSearchParams) return source;
  if (typeof source === 'string') {
    const q = source.indexOf('?') >= 0 ? source.slice(source.indexOf('?') + 1) : source;
    return new URLSearchParams(q);
  }
  if (typeof source === 'object') {
    if (typeof source.search === 'string') return new URLSearchParams(source.search);
    try {
      return new URLSearchParams(source);
    } catch {
      return new URLSearchParams('');
    }
  }
  return new URLSearchParams('');
}

/**
 * Finite positive number, else fallback. Rejects 0, negatives, NaN, Infinity.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveOr(value, fallback) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Finite integer (truncated), else fallback. 0 is a valid seed.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function integerOr(value, fallback) {
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Parse `?duration=&speed=&seed=` with the brief's defaults. Invalid or
 * missing values fall back to the default rather than throwing — a mistyped
 * URL must still render a tree.
 *
 * @param {*} [source] Query string, URL, Location, URLSearchParams, or object.
 *                     Omitted -> `globalThis.location.search` (empty in Node).
 * @returns {{duration: number, speed: number, seed: number}}
 */
export function parseParams(source) {
  const params = toSearchParams(source);
  return {
    duration: positiveOr(params.get('duration'), DEFAULTS.duration),
    speed: positiveOr(params.get('speed'), DEFAULTS.speed),
    seed: integerOr(params.get('seed'), DEFAULTS.seed),
  };
}

// ---------------------------------------------------------------------------
// Default (browser) time source and frame scheduler
// ---------------------------------------------------------------------------

function defaultNow() {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') return () => perf.now();
  return () => Date.now();
}

function defaultRaf() {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return (cb) => globalThis.requestAnimationFrame(cb);
  }
  // Node / worker fallback: ~60Hz. Headless callers pass `raf: null` instead.
  return (cb) => setTimeout(cb, 16);
}

function defaultCancelRaf() {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    return (id) => globalThis.cancelAnimationFrame(id);
  }
  return (id) => clearTimeout(id);
}

// ---------------------------------------------------------------------------
// GrowthClock
// ---------------------------------------------------------------------------

export class GrowthClock {
  #duration;
  #speed;
  #seed;
  #now;
  #raf;
  #cancelRaf;

  #started = false;
  #startMs = 0;
  #pausedAtMs = null;
  #pausedTotalMs = 0;
  #lastRealMs = 0; // monotonic guard: t must never go backwards
  #stopped = false;

  #frame;
  #subscribers = new Set();
  #rafId = null;
  #loop;

  /**
   * @param {object} [options]
   * @param {number} [options.duration]  Model seconds for a full run (default 3600).
   * @param {number} [options.speed]     Multiplier on real time (default 1).
   * @param {number} [options.seed]      Integer seed passed to both panels (default 42).
   * @param {() => number} [options.now] Injected time source, in MILLISECONDS.
   *                                     Default: performance.now(), else Date.now().
   * @param {((cb: (ts: number) => void) => any)|null} [options.raf]
   *                                     Frame scheduler. `null` = manual only (headless).
   * @param {(id: any) => void} [options.cancelRaf]
   * @param {boolean} [options.autoStart] Start on construction (default true).
   */
  constructor(options = {}) {
    this.#duration = positiveOr(options.duration, DEFAULTS.duration);
    this.#speed = positiveOr(options.speed, DEFAULTS.speed);
    this.#seed = integerOr(options.seed, DEFAULTS.seed);
    this.#now = typeof options.now === 'function' ? options.now : defaultNow();
    this.#raf =
      options.raf === null ? null : typeof options.raf === 'function' ? options.raf : defaultRaf();
    this.#cancelRaf =
      typeof options.cancelRaf === 'function' ? options.cancelRaf : defaultCancelRaf();

    // The rAF timestamp argument is deliberately ignored: the injected time
    // source is the only clock, so tests and the browser agree exactly.
    this.#loop = () => {
      this.#rafId = null;
      this.tick();
      this.#schedule();
    };

    this.#frame = this.#frameAt(0);
    if (options.autoStart !== false) this.start();
  }

  // --- configuration (read-only) ---
  /** @returns {number} */
  get duration() {
    return this.#duration;
  }
  /** @returns {number} */
  get speed() {
    return this.#speed;
  }
  /** @returns {number} */
  get seed() {
    return this.#seed;
  }
  /** @returns {boolean} */
  get started() {
    return this.#started;
  }
  /** @returns {boolean} */
  get paused() {
    return this.#pausedAtMs !== null;
  }

  // --- live state ---
  /** Normalized time, exactly within [0, 1]. @returns {number} */
  get t() {
    return this.sample().t;
  }
  /** Model seconds elapsed, clamped to duration. @returns {number} */
  get elapsed() {
    return this.sample().elapsed;
  }
  /** Real (unscaled) seconds since start. @returns {number} */
  get realElapsed() {
    return this.sample().realElapsed;
  }
  /** @returns {PhaseName} */
  get phase() {
    return this.sample().phase;
  }
  /** True once t has reached 1 and the clock stopped. @returns {boolean} */
  get done() {
    return this.sample().done;
  }
  /** Full immutable frame for right now. @returns {GrowthFrame} */
  get frame() {
    return this.sample();
  }
  /** The last frame actually broadcast to subscribers. @returns {GrowthFrame} */
  get lastFrame() {
    return this.#frame;
  }

  /**
   * (Re)start from zero at the current (or given) instant.
   * @param {number} [nowMs]
   * @returns {this}
   */
  start(nowMs = this.#now()) {
    this.#started = true;
    this.#startMs = nowMs;
    this.#pausedAtMs = null;
    this.#pausedTotalMs = 0;
    this.#lastRealMs = 0;
    this.#stopped = false;
    this.#frame = this.#frameAt(nowMs);
    this.#schedule();
    return this;
  }

  /**
   * Freeze time without losing progress. Growth holds where it is.
   * @param {number} [nowMs]
   * @returns {this}
   */
  pause(nowMs = this.#now()) {
    if (!this.#started || this.#pausedAtMs !== null) return this;
    this.#pausedAtMs = nowMs;
    this.#cancelLoop();
    return this;
  }

  /**
   * Resume after a pause; paused wall time is not counted toward growth.
   * @param {number} [nowMs]
   * @returns {this}
   */
  resume(nowMs = this.#now()) {
    if (!this.#started || this.#pausedAtMs === null) return this;
    const delta = nowMs - this.#pausedAtMs;
    this.#pausedTotalMs += Number.isFinite(delta) && delta > 0 ? delta : 0;
    this.#pausedAtMs = null;
    this.#schedule();
    return this;
  }

  /**
   * Read the clock without broadcasting. Pure with respect to a given `nowMs`.
   * @param {number} [nowMs]
   * @returns {GrowthFrame}
   */
  sample(nowMs = this.#now()) {
    return this.#frameAt(nowMs);
  }

  /**
   * Advance to `nowMs`, remember it, and broadcast to subscribers.
   * The rAF loop calls this; tests call it directly.
   * @param {number} [nowMs]
   * @returns {GrowthFrame}
   */
  tick(nowMs = this.#now()) {
    const frame = this.#frameAt(nowMs);
    this.#lastRealMs = frame.realElapsed * 1000;
    this.#frame = frame;
    if (frame.done) this.#stopped = true; // t clamped at 1 — the clock stops here
    this.#emit(frame);
    return frame;
  }

  /**
   * Subscribe to frames. The callback fires immediately with the current
   * frame, then once per animation frame until t reaches 1 — after which the
   * loop is cancelled and never rescheduled.
   *
   * @param {(frame: GrowthFrame) => void} callback
   * @returns {() => void} unsubscribe
   */
  subscribe(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('GrowthClock.subscribe(callback): callback must be a function');
    }
    this.#subscribers.add(callback);
    callback(this.sample());
    this.#schedule();
    return () => {
      this.#subscribers.delete(callback);
      if (this.#subscribers.size === 0) this.#cancelLoop();
    };
  }

  /** Drop all subscribers and cancel any pending frame. @returns {void} */
  destroy() {
    this.#subscribers.clear();
    this.#cancelLoop();
  }

  // --- internals ---

  #realElapsedMs(nowMs) {
    if (!this.#started) return 0;
    const end = this.#pausedAtMs === null ? nowMs : this.#pausedAtMs;
    let ms = end - this.#startMs - this.#pausedTotalMs;
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    if (ms < this.#lastRealMs) ms = this.#lastRealMs; // never run backwards
    return ms;
  }

  #frameAt(nowMs) {
    const realMs = this.#realElapsedMs(nowMs);
    const modelSeconds = (realMs * this.#speed) / 1000;
    const t = normalizedTime(modelSeconds, this.#duration);
    return frameFromT(t, {
      duration: this.#duration,
      speed: this.#speed,
      seed: this.#seed,
      realElapsed: realMs / 1000,
    });
  }

  #emit(frame) {
    for (const cb of [...this.#subscribers]) {
      try {
        cb(frame);
      } catch (err) {
        // One bad subscriber must not stall the other panel; surface it async.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  #schedule() {
    if (
      this.#raf === null ||
      this.#rafId !== null ||
      this.#stopped ||
      !this.#started ||
      this.#pausedAtMs !== null ||
      this.#subscribers.size === 0
    ) {
      return;
    }
    this.#rafId = this.#raf(this.#loop);
  }

  #cancelLoop() {
    if (this.#rafId !== null) {
      this.#cancelRaf(this.#rafId);
      this.#rafId = null;
    }
  }
}

/**
 * Browser entry point: read the URL, then apply explicit overrides.
 *
 * @param {object} [options] Any GrowthClock option, plus:
 * @param {*} [options.search] Query source (string/URL/Location/URLSearchParams).
 *                             Omitted -> `globalThis.location.search`.
 * @returns {GrowthClock}
 */
export function createGrowthClock(options = {}) {
  const { search, ...rest } = options;
  const merged = { ...parseParams(search) };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) merged[key] = value;
  }
  return new GrowthClock(merged);
}

// ---------------------------------------------------------------------------
// Headless clock — pure, Node-usable, driven by hand. No real time passes.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HeadlessClock
 * @property {GrowthClock} clock
 * @property {() => number} now                 Current virtual time in ms.
 * @property {(ms: number) => GrowthFrame} advanceMs
 * @property {(seconds: number) => GrowthFrame} advanceSeconds Real seconds (speed applies).
 * @property {(ms: number) => GrowthFrame} setMs
 * @property {(t: number) => GrowthFrame} seekTo Jump to a normalized time (forward only).
 * @property {() => GrowthFrame} sample
 * @property {(cb: (f: GrowthFrame) => void) => () => void} subscribe
 */

/**
 * A GrowthClock with a virtual time source and no animation frames. Every
 * advance is explicit, so a 3600s run can be walked end to end inside a unit
 * test with zero wall-clock time.
 *
 * @param {object} [options] GrowthClock options, plus `startMs` (default 0).
 * @returns {HeadlessClock}
 */
export function createHeadlessClock(options = {}) {
  const { startMs = 0, ...rest } = options;
  let virtualMs = Number.isFinite(startMs) ? startMs : 0;
  const clock = new GrowthClock({ ...rest, now: () => virtualMs, raf: null });

  const setMs = (ms) => {
    virtualMs = Number.isFinite(ms) ? ms : virtualMs;
    return clock.tick(virtualMs);
  };

  const api = {
    clock,
    now: () => virtualMs,
    advanceMs: (ms) => setMs(virtualMs + (Number.isFinite(ms) ? ms : 0)),
    advanceSeconds: (seconds) => api.advanceMs((Number.isFinite(seconds) ? seconds : 0) * 1000),
    setMs,
    /** Jump to normalized time `t` (clamped; the clock never runs backwards). */
    seekTo: (t) => setMs(startMs + (clock.duration * clamp01(t) * 1000) / clock.speed),
    sample: () => clock.sample(virtualMs),
    subscribe: (cb) => clock.subscribe(cb),
  };
  return api;
}

export default GrowthClock;
