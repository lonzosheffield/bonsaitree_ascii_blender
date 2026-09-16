/**
 * N1 proof harness: diff src/shared/glibc-rand.js against golden vectors
 * captured from real glibc inside Docker. Writes proof/M0/rand-match.txt.
 *
 * Usage: node proof/M0/compare-rand.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GlibcRandom } from '../../src/shared/glibc-rand.js';
import { fnv1a64, parseDeepGolden } from '../../test/helpers/fnv1a64.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, 'glibc-golden.txt');

/**
 * Parse the golden file into [{ seed, values }].
 * @param {string} text Raw golden file contents.
 * @returns {{meta: string[], blocks: {seed: number, values: number[]}[]}}
 */
export function parseGolden(text) {
	const meta = [];
	const blocks = [];
	let current = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '') continue;
		if (line.startsWith('#')) { meta.push(line); continue; }
		if (line.startsWith('seed ')) {
			current = { seed: Number(line.slice(5)), values: [] };
			blocks.push(current);
			continue;
		}
		if (!current) throw new Error(`value before any "seed" header: ${line}`);
		current.values.push(Number(line));
	}
	return { meta, blocks };
}

const { meta, blocks } = parseGolden(readFileSync(goldenPath, 'utf8'));

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

say('N1 PROOF — glibc random() TYPE_3 in JavaScript vs. real glibc');
say('='.repeat(64));
say('');
say('golden source : proof/M0/glibc-golden.txt (generated in Docker)');
say('golden program: proof/M0/glibc-golden.c   (srand(S); then bare rand())');
say('container     : debian:bookworm-slim, gcc -O2 -std=c11');
for (const m of meta) say(`  ${m}`);
say('implementation: src/shared/glibc-rand.js (GlibcRandom, TYPE_3 deg 31 sep 3)');
say(`node          : ${process.version}`);
say(`generated at  : ${new Date().toISOString()}`);
say('');
say('How to reproduce from a clean checkout');
say('-'.repeat(64));
say("  1. Build the golden vectors inside a real glibc container:");
say("       docker run --rm -i debian:bookworm-slim sh -c \\");
say("         'cat > /tmp/g.c; apt-get update -qq; \\");
say("          apt-get install -y -qq gcc libc6-dev; \\");
say("          gcc -O2 -std=c11 -o /tmp/g /tmp/g.c; /tmp/g' \\");
say("         < proof/M0/glibc-golden.c > proof/M0/glibc-golden.txt");
say("       Repeat with glibc-golden-deep.c -> glibc-golden-deep.txt.");
say("  2. node proof/M0/compare-rand.mjs        # regenerates this file");
say("  3. node --test test/glibc-rand.test.mjs  # asserts the same vectors");
say('');
say('Per-seed comparison');
say('-'.repeat(64));

let total = 0;
let matched = 0;
const mismatches = [];

for (const { seed, values } of blocks) {
	const gen = new GlibcRandom(seed);
	let ok = 0;
	for (let i = 0; i < values.length; i++) {
		const got = gen.rand();
		total++;
		if (got === values[i]) { ok++; matched++; }
		else if (mismatches.length < 20) {
			mismatches.push(`seed ${seed} index ${i}: glibc=${values[i]} js=${got}`);
		}
	}
	const head = values.slice(0, 3).join(', ');
	say(
		`seed ${String(seed).padStart(10)}  ${String(ok).padStart(4)}/${String(values.length).padEnd(4)} match  ` +
		`${ok === values.length ? 'OK  ' : 'FAIL'}  first three: ${head}`
	);
}

say('-'.repeat(64));
say('');

// ---------------------------------------------------------------------------
// Long-stream check. cbonsai makes thousands of rand() calls per tree, so a
// 200-value match is not enough on its own: a ring-buffer or tap-pointer error
// could hide until deep into the stream. Compare FNV-1a-64 digests of 100000
// outputs per seed instead, including the two seeds that exercise the signed
// int32 seeding edge (0 -> 1, and 4294967295 -> negative word).
// ---------------------------------------------------------------------------

const deepPath = join(here, 'glibc-golden-deep.txt');
const deepRows = parseDeepGolden(readFileSync(deepPath, 'utf8'));

say('Long-stream digest comparison (100000 values per seed)');
say('-'.repeat(64));

let deepTotal = 0;
let deepMatched = 0;
let deepSeedsOk = 0;
for (const { seed, digest } of deepRows) {
	const got = fnv1a64(seed, 100000);
	const ok = got === digest;
	if (ok) { deepSeedsOk++; deepMatched += 100000; }
	deepTotal += 100000;
	say(`seed ${String(seed).padStart(10)}  glibc=${digest}  js=${got}  ${ok ? 'OK' : 'FAIL'}`);
}

say('-'.repeat(64));
say(`deep seeds compared : ${deepRows.length} (${deepRows.map((d) => d.seed).join(', ')})`);
say(`deep values covered : ${deepTotal}`);
say(`deep seeds matching : ${deepSeedsOk}/${deepRows.length}`);
say('');

say('Totals');
say('-'.repeat(64));
say(`seeds compared : ${blocks.length} (${blocks.map((b) => b.seed).join(', ')})`);
say(`values compared: ${total}`);
say(`values matched : ${matched}`);
say(`values differing: ${total - matched}`);
say('');
if (mismatches.length) {
	say('First mismatches:');
	for (const m of mismatches) say(`  ${m}`);
	say('');
}
const pass = total > 0 && matched === total && deepSeedsOk === deepRows.length;
say(`value-by-value : ${matched}/${total} matched`);
say(`long-stream    : ${deepMatched}/${deepTotal} values covered by matching digests`);
say('');
say(pass ? 'RESULT: EXACT MATCH — N1 SATISFIED' : 'RESULT: MISMATCH — N1 VIOLATED');

writeFileSync(join(here, 'rand-match.txt'), lines.join('\n') + '\n');
process.exit(pass ? 0 : 1);
