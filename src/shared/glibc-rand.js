/**
 * glibc `random()` / `rand()` — TYPE_3 additive-feedback generator.
 *
 * NON-NEGOTIABLE N1 (docs/BRIEF.md). cbonsai calls `srand(conf.seed)` at
 * vendor/cbonsai/cbonsai.c:1062 and then uses bare `rand()`. In glibc, `rand()`
 * is `random()`, which by default is TYPE_3: degree 31, separation 3.
 *
 * This is a line-for-line port of glibc's __srandom_r / __random_r
 * (stdlib/random_r.c), NOT an approximation:
 *
 *   seeding   r[0] = seed (0 becomes 1)
 *             r[i] = (16807 * r[i-1]) % 2147483647   for i in 1..30,
 *             computed with Schrage's trick so the intermediate never
 *             overflows 31 bits:
 *                 hi   = floor(w / 127773)
 *                 lo   = w % 127773
 *                 w    = 16807 * lo - 2836 * hi
 *                 if (w < 0) w += 2147483647
 *             r[i] = r[i - 31]                       for i in 31..33
 *
 *   warm-up   the first 310 outputs are generated and discarded
 *             (glibc spins the generator 10 * deg = 310 times)
 *
 *   output    r[i] = (r[i - 31] + r[i - 3]) mod 2^32
 *             return r[i] >>> 1                      (RAND_MAX = 2147483647)
 *
 * No Mersenne Twister, no LCG, no Math.random, no npm dependency.
 * Verified byte-exact against glibc 2.36 in Docker: see proof/M0/rand-match.txt
 * and test/glibc-rand.test.mjs.
 *
 * @module shared/glibc-rand
 */

/** Degree of the TYPE_3 polynomial: x**31 + x**3 + 1. */
export const DEG = 31;
/** Separation (the short tap) of the TYPE_3 polynomial. */
export const SEP = 3;
/** glibc spins the generator this many times after seeding, discarding output. */
export const WARMUP = 10 * DEG; // 310
/** Largest value `rand()` can return, matching glibc's RAND_MAX. */
export const RAND_MAX = 2147483647;

const MODULUS = 2147483647; // 2**31 - 1, the Lehmer modulus
const MULT = 16807; // 7**5
const Q = 127773; // floor(MODULUS / MULT)
const R = 2836; // MODULUS % MULT

/**
 * A seedable glibc-compatible random number generator.
 *
 * Holds the 31-word additive-feedback state plus the two tap pointers, exactly
 * as glibc's `struct random_data` does. Instances are independent, so two trees
 * can be grown side by side without sharing a stream.
 */
export class GlibcRandom {
	/**
	 * @param {number} [seed] Optional seed; when given, `srand(seed)` is called.
	 */
	constructor(seed) {
		/** @type {Int32Array} the r[] ring buffer (glibc's `state`) */
		this.state = new Int32Array(DEG);
		/** @type {number} index of the r[i-3] tap (glibc's `fptr`) */
		this.f = 0;
		/** @type {number} index of the r[i-31] tap (glibc's `rptr`) */
		this.r = 0;
		this.srand(seed === undefined ? 1 : seed);
	}

	/**
	 * Seed the generator. Equivalent to C `srand(seed)` / `srandom(seed)`.
	 *
	 * @param {number} seed Any integer; it is taken modulo 2**32 as C would
	 *   coerce it to `unsigned int`. A seed of 0 becomes 1, as glibc does.
	 * @returns {void}
	 */
	srand(seed) {
		// C: srand(unsigned int seed) — truncate to 32 bits, unsigned.
		let s = seed >>> 0;
		// glibc: "We must make sure the seed is not 0. Take arbitrarily 1."
		if (s === 0) s = 1;

		const state = this.state;
		state[0] = s | 0;

		// glibc holds the running word in an `int32_t`, not an unsigned or a
		// long — so a seed at or above 2**31 is already negative here. That
		// matters: hi/lo then come out negative (C division truncates toward
		// zero, and so does JS `%` and Math.trunc), the product is negative,
		// and the `+= 2147483647` correction pulls it back into range. This is
		// the "signed-overflow correction" N1 calls for; getting it wrong only
		// shows up for seeds >= 2**31, which is exactly why the proof harness
		// includes 4294967295. The intermediates stay far inside 2**53, so the
		// arithmetic below is exact in JS doubles.
		let word = s | 0;
		for (let i = 1; i < DEG; i++) {
			const hi = Math.trunc(word / Q);
			const lo = word % Q;
			word = MULT * lo - R * hi;
			if (word < 0) word += MODULUS;
			state[i] = word;
		}

		// glibc sets fptr = &state[SEP], rptr = &state[0] and then discards
		// 10 * DEG outputs. Indices 31..33 of the conceptual r[] array are
		// r[i-31], i.e. r[0..2], which the ring buffer gives us for free.
		this.f = SEP;
		this.r = 0;
		for (let i = 0; i < WARMUP; i++) this.rand();
	}

	/**
	 * Produce the next value. Equivalent to C `rand()` / `random()`.
	 *
	 * @returns {number} An integer in [0, 2147483647].
	 */
	rand() {
		const state = this.state;
		// r[i] = (r[i-31] + r[i-3]) mod 2**32
		const sum = ((state[this.f] >>> 0) + (state[this.r] >>> 0)) >>> 0;
		state[this.f] = sum | 0;
		// glibc returns (uint32_t)val >> 1 — the low bit is dropped because it
		// has period 2**31, far shorter than the rest of the word.
		const result = sum >>> 1;

		if (++this.f >= DEG) this.f = 0;
		if (++this.r >= DEG) this.r = 0;
		return result;
	}

	/**
	 * Convenience: a uniform integer in [0, n), matching cbonsai's `rand() % n`.
	 *
	 * @param {number} n Exclusive upper bound; must be a positive integer.
	 * @returns {number} An integer in [0, n).
	 */
	randInt(n) {
		return this.rand() % n;
	}

	/**
	 * Convenience: a float in [0, 1). Not used by the cbonsai port — the port
	 * must use `rand()` so the integer stream matches glibc exactly.
	 *
	 * @returns {number} A float in [0, 1).
	 */
	random() {
		return this.rand() / (RAND_MAX + 1);
	}
}

/**
 * Create a generator seeded with `seed`.
 *
 * @param {number} seed The seed, as passed to C `srand()`.
 * @returns {GlibcRandom} A freshly seeded generator.
 */
export function createGlibcRandom(seed) {
	return new GlibcRandom(seed);
}

/**
 * Generate the first `count` outputs for `seed` in one call — handy for tests
 * and for diffing against golden vectors captured from real glibc.
 *
 * @param {number} seed The seed, as passed to C `srand()`.
 * @param {number} count How many values to produce.
 * @returns {number[]} The values, in call order.
 */
export function randSequence(seed, count) {
	const gen = new GlibcRandom(seed);
	const out = new Array(count);
	for (let i = 0; i < count; i++) out[i] = gen.rand();
	return out;
}

// ---------------------------------------------------------------------------
// Module-level generator, mirroring C's single global rand() stream. cbonsai
// uses the global one; the port may too, but prefer an explicit instance.
// ---------------------------------------------------------------------------

const globalGen = new GlibcRandom(1);

/**
 * Seed the module-level generator. Equivalent to C `srand(seed)`.
 *
 * @param {number} seed The seed.
 * @returns {void}
 */
export function srand(seed) {
	globalGen.srand(seed);
}

/**
 * Next value from the module-level generator. Equivalent to C `rand()`.
 *
 * @returns {number} An integer in [0, 2147483647].
 */
export function rand() {
	return globalGen.rand();
}

export default GlibcRandom;
