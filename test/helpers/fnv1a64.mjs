/**
 * FNV-1a-64 digest of a glibc-rand stream. Test/proof helper only — it is
 * deliberately NOT part of src/shared/glibc-rand.js, which stays pure N1 code.
 *
 * The C side (proof/M0/glibc-golden-deep.c) hashes each `rand()` result as four
 * big-endian bytes with the same basis and prime, so the two digests are
 * directly comparable. The basis below is the constant literally written in
 * that C program.
 */
import { GlibcRandom } from '../../src/shared/glibc-rand.js';

const MASK64 = (1n << 64n) - 1n;
const BASIS = 1469598103934665603n;
const PRIME = 1099511628211n;

/**
 * Digest the first `count` outputs of the generator seeded with `seed`.
 *
 * @param {number} seed Seed passed to srand().
 * @param {number} count How many values to consume.
 * @returns {bigint} The FNV-1a-64 digest.
 */
export function fnv1a64(seed, count) {
	const gen = new GlibcRandom(seed);
	let acc = BASIS;
	for (let i = 0; i < count; i++) {
		const v = gen.rand();
		acc = ((acc ^ BigInt((v >>> 24) & 0xff)) * PRIME) & MASK64;
		acc = ((acc ^ BigInt((v >>> 16) & 0xff)) * PRIME) & MASK64;
		acc = ((acc ^ BigInt((v >>> 8) & 0xff)) * PRIME) & MASK64;
		acc = ((acc ^ BigInt(v & 0xff)) * PRIME) & MASK64;
	}
	return acc;
}

/**
 * Parse proof/M0/glibc-golden-deep.txt.
 *
 * @param {string} text File contents.
 * @returns {{seed: number, digest: bigint}[]}
 */
export function parseDeepGolden(text) {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith('#'))
		.map((l) => {
			const [seed, digest] = l.split(/\s+/);
			return { seed: Number(seed), digest: BigInt(digest) };
		});
}
