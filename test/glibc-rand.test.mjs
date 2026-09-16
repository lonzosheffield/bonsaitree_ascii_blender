/**
 * N1 — src/shared/glibc-rand.js must reproduce glibc's rand() exactly.
 *
 * The vectors in proof/M0/glibc-golden.txt were produced by compiling
 * proof/M0/glibc-golden.c inside debian:bookworm-slim (glibc 2.36) and running
 * `srand(S)` followed by 200 bare `rand()` calls for each of five seeds —
 * precisely what vendor/cbonsai/cbonsai.c:1062 does.
 *
 * Run: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import GlibcRandom, {
	createGlibcRandom,
	randSequence,
	srand,
	rand,
	DEG,
	SEP,
	WARMUP,
	RAND_MAX,
} from '../src/shared/glibc-rand.js';
import { fnv1a64, parseDeepGolden } from './helpers/fnv1a64.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const GOLDEN = join(root, 'proof', 'M0', 'glibc-golden.txt');
const GOLDEN_DEEP = join(root, 'proof', 'M0', 'glibc-golden-deep.txt');
const SOURCE = join(root, 'src', 'shared', 'glibc-rand.js');

/**
 * Parse the captured glibc vectors.
 * @returns {{seed: number, values: number[]}[]}
 */
function loadGolden() {
	const blocks = [];
	let current = null;
	for (const raw of readFileSync(GOLDEN, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		if (line.startsWith('seed ')) {
			current = { seed: Number(line.slice(5)), values: [] };
			blocks.push(current);
			continue;
		}
		current.values.push(Number(line));
	}
	return blocks;
}

const golden = loadGolden();

test('golden vectors loaded: 5 seeds x 200 values', () => {
	assert.equal(golden.length, 5);
	assert.deepEqual(golden.map((b) => b.seed), [1, 42, 1337, 99999, 2147483647]);
	for (const b of golden) assert.equal(b.values.length, 200);
	assert.equal(golden.reduce((n, b) => n + b.values.length, 0), 1000);
});

test('TYPE_3 parameters match glibc (degree 31, separation 3, 310 discards)', () => {
	assert.equal(DEG, 31);
	assert.equal(SEP, 3);
	assert.equal(WARMUP, 310);
	assert.equal(RAND_MAX, 2147483647);
});

for (const { seed, values } of golden) {
	test(`seed ${seed}: all 200 values match real glibc exactly`, () => {
		const gen = new GlibcRandom(seed);
		for (let i = 0; i < values.length; i++) {
			assert.equal(gen.rand(), values[i], `divergence at index ${i} for seed ${seed}`);
		}
	});
}

test('all 1000 captured values match, none differ', () => {
	let total = 0;
	let matched = 0;
	for (const { seed, values } of golden) {
		const gen = new GlibcRandom(seed);
		for (const want of values) {
			total++;
			if (gen.rand() === want) matched++;
		}
	}
	assert.equal(total, 1000);
	assert.equal(matched, 1000);
});

test('module-level srand()/rand() mirror the C global stream', () => {
	for (const { seed, values } of golden) {
		srand(seed);
		for (let i = 0; i < 50; i++) assert.equal(rand(), values[i]);
	}
});

test('randSequence() and createGlibcRandom() agree with the class', () => {
	const seq = randSequence(1337, 200);
	assert.deepEqual(seq, golden[2].values);
	const gen = createGlibcRandom(42);
	assert.equal(gen.rand(), golden[1].values[0]);
});

test('same seed twice yields an identical stream (M1 reproducibility)', () => {
	const a = randSequence(99999, 500);
	const b = randSequence(99999, 500);
	assert.deepEqual(a, b);
});

test('different seeds yield different streams', () => {
	assert.notDeepEqual(randSequence(1, 50), randSequence(42, 50));
});

test('re-seeding an existing instance resets it', () => {
	const gen = new GlibcRandom(1);
	for (let i = 0; i < 37; i++) gen.rand();
	gen.srand(42);
	for (let i = 0; i < 20; i++) assert.equal(gen.rand(), golden[1].values[i]);
});

test('seed 0 is treated as seed 1, as glibc does', () => {
	assert.deepEqual(randSequence(0, 20), golden[0].values.slice(0, 20));
});

test('outputs stay within [0, RAND_MAX] over a long run', () => {
	const gen = new GlibcRandom(2026);
	for (let i = 0; i < 100000; i++) {
		const v = gen.rand();
		assert.ok(Number.isInteger(v) && v >= 0 && v <= RAND_MAX, `bad value ${v} at ${i}`);
	}
});

test('instances are independent (no shared global state)', () => {
	const a = new GlibcRandom(1);
	const b = new GlibcRandom(1);
	a.rand();
	a.rand();
	assert.equal(b.rand(), golden[0].values[0]);
});

// ---------------------------------------------------------------------------
// Long-stream equivalence. cbonsai draws thousands of values per tree, so a
// 200-value prefix match is not sufficient evidence on its own: a tap-pointer
// or ring-buffer bug can stay hidden for a while. These digests cover 100000
// values per seed, including the two seeds that exercise the int32 seeding
// edge (0, which glibc rewrites to 1, and 4294967295, which is negative once
// glibc truncates it to int32_t).
// ---------------------------------------------------------------------------

const deepGolden = parseDeepGolden(readFileSync(GOLDEN_DEEP, 'utf8'));

test('long-stream golden digests loaded: 8 seeds', () => {
	assert.equal(deepGolden.length, 8);
	assert.deepEqual(
		deepGolden.map((d) => d.seed),
		[1, 42, 1337, 99999, 2147483647, 0, 4294967295, 7]
	);
});

for (const { seed, digest } of deepGolden) {
	test(`seed ${seed}: 100000-value stream digest matches real glibc`, () => {
		assert.equal(fnv1a64(seed, 100000), digest);
	});
}

test('seed 4294967295 exercises the signed int32 seeding correction', () => {
	// glibc stores the seeding word in an int32_t, so this seed is -1 there.
	// A naive unsigned port diverges from the very first output.
	const gen = new GlibcRandom(4294967295);
	const naive = new GlibcRandom(-1); // same 32-bit pattern, must agree
	for (let i = 0; i < 100; i++) assert.equal(gen.rand(), naive.rand());
});

test('no forbidden PRNG: no Math.random, no imports, no npm dependency', () => {
	const src = readFileSync(SOURCE, 'utf8');
	const code = src
		.replace(/\/\*[\s\S]*?\*\//g, '') // block comments
		.replace(/^\s*\/\/.*$/gm, ''); // line comments
	assert.ok(!/Math\.random/.test(code), 'Math.random is forbidden by N1');
	assert.ok(!/\bimport\s/.test(code), 'the generator must have zero dependencies');
	assert.ok(!/\brequire\s*\(/.test(code), 'the generator must have zero dependencies');
	assert.ok(!/mersenne|mt19937|xorshift|splitmix|pcg/i.test(code), 'wrong generator family');
	assert.ok(/16807/.test(code) && /127773/.test(code) && /2836/.test(code), 'Schrage seeding absent');
});
