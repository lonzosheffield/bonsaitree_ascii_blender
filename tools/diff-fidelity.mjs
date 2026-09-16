#!/usr/bin/env node
/**
 * diff-fidelity.mjs — the M1 fidelity gate.
 *
 * Runs the JS port (src/ascii/bonsai.js) to COMPLETION for each golden seed at
 * exactly 80 columns x 40 rows, and diffs the resulting CHARACTER GRID against
 * the golden text captured from REAL cbonsai (proof/M1/golden/seed-<N>.txt,
 * produced by tools/golden.sh inside the Docker container).
 *
 * WHAT IS COMPARED
 *   The raw character grid: 40 lines of 80 cells.
 *
 * WHAT IS NORMALIZED — and nothing else
 *   1. Line endings: CRLF / CR -> LF.
 *   2. Trailing whitespace at the end of each line, and trailing blank lines.
 *   3. SGR escape sequences are REMOVED FROM THE GOLDEN, because
 *      `cbonsai -p` interleaves a colour escape before every single cell
 *      (cbonsai.c:741-748) and there is no character grid underneath until they
 *      are stripped. The strip uses the tolerant pattern BRIEF N3-addendum
 *      demands (`\x1b\[[0-9;-]*m`), which catches cbonsai's malformed
 *      `ESC[3-1m` for default-coloured cells.
 *
 *   NO other normalization. Characters are compared by code point. Interior
 *   whitespace, leading whitespace, and every glyph are compared verbatim. A
 *   mismatch is reported as a mismatch; nothing here exists to manufacture a
 *   pass.
 *
 * The SGR strip is independently corroborated: for each seed the tool also
 * checks its stripped grid against the separately-captured
 * `seed-<N>.plain.txt`, so a bug in the strip cannot silently move the goal
 * posts.
 *
 * Usage:  node tools/diff-fidelity.mjs [--out <path>] [--quiet]
 * Exit:   0 if all seeds match, 1 otherwise.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { growBonsai } from '../src/ascii/bonsai.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GOLDEN_DIR = join(ROOT, 'proof', 'M1', 'golden');

/** The golden seeds the M1 gate is scored on. */
const SEEDS = [1, 42, 1337, 99999, 2147483647];

/** BRIEF N2: the canonical terminal geometry. Both sides use exactly this. */
const COLS = 80;
const ROWS = 40;

/**
 * BRIEF N3 addendum: cbonsai emits `ESC[3-1m` for fg == -1, which a strict
 * `\x1b\[[0-9;]*m` misses because of the '-'. This class includes it.
 */
const SGR = /\x1b\[[0-9;-]*m/g;

/**
 * Strip SGR colour/attribute escapes, leaving the character grid.
 *
 * @param {string} s Print-mode text from `cbonsai -p`.
 * @returns {string} The same text with SGR sequences removed.
 */
function stripSgr(s) {
	return s.replace(SGR, '');
}

/**
 * The ONLY normalization applied to either side: line endings and trailing
 * whitespace (per line and at the end of the grid).
 *
 * @param {string} s Text to normalize.
 * @returns {string[]} Lines, right-trimmed, with trailing blank lines dropped.
 */
function normalizeToLines(s) {
	const lines = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	// Trailing whitespace per line.
	for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/[ \t]+$/, '');
	// Trailing blank lines (the file's final newline, and cbonsai's reset line,
	// which is empty once SGR is stripped).
	while (lines.length && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * Compare two normalized grids cell by cell.
 *
 * @param {string[]} got Lines produced by the JS port.
 * @param {string[]} want Lines from the golden.
 * @returns {{equal: boolean, mismatches: number, firstLine: number,
 *            firstCol: number, gotLine: string, wantLine: string,
 *            lineCountDiff: boolean}}
 */
function compareGrids(got, want) {
	const nLines = Math.max(got.length, want.length);
	let mismatches = 0;
	let firstLine = -1;
	let firstCol = -1;

	for (let i = 0; i < nLines; i++) {
		const a = got[i] === undefined ? '' : got[i];
		const b = want[i] === undefined ? '' : want[i];
		if (a === b) continue;
		// Cell-level: compare by code point, padding the shorter with spaces so
		// a length difference counts as real mismatched cells rather than being
		// silently forgiven.
		const ca = [...a];
		const cb = [...b];
		const width = Math.max(ca.length, cb.length);
		for (let x = 0; x < width; x++) {
			const ga = ca[x] === undefined ? ' ' : ca[x];
			const gb = cb[x] === undefined ? ' ' : cb[x];
			if (ga === gb) continue;
			mismatches++;
			if (firstLine === -1) {
				firstLine = i;
				firstCol = x;
			}
		}
	}

	return {
		equal: mismatches === 0 && got.length === want.length,
		mismatches,
		firstLine,
		firstCol,
		gotLine: firstLine === -1 ? '' : (got[firstLine] === undefined ? '<missing line>' : got[firstLine]),
		wantLine: firstLine === -1 ? '' : (want[firstLine] === undefined ? '<missing line>' : want[firstLine]),
		lineCountDiff: got.length !== want.length,
	};
}

/**
 * Render a line with a caret under the first differing column.
 *
 * @param {string} line The line text.
 * @param {number} col Zero-based column of the first mismatch.
 * @returns {string} A caret ruler aligned under `col`.
 */
function caretRuler(col) {
	return ' '.repeat(Math.max(0, col)) + '^';
}

/**
 * Show a line with spaces made visible, so a whitespace-only difference is
 * legible in the report.
 *
 * @param {string} line The line.
 * @returns {string} The line with spaces shown as '·'.
 */
function visible(line) {
	return line.replace(/ /g, '·');
}

// --------------------------------------------------------------------- main

const args = process.argv.slice(2);
let outPath = join(ROOT, 'proof', 'M1', 'fidelity-diff.txt');
let quiet = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--out') outPath = resolve(args[++i]);
	else if (args[i] === '--quiet') quiet = true;
}

const report = [];
const say = (line = '') => {
	report.push(line);
	if (!quiet) console.log(line);
};

say('M1 FIDELITY DIFF — JS port vs. REAL cbonsai golden text');
say('='.repeat(72));
say(`generated       : ${new Date().toISOString()}`);
say(`port            : src/ascii/bonsai.js  (run-to-completion, frameAt(t=1))`);
say(`golden          : proof/M1/golden/seed-<N>.txt  (cbonsai -p -s <N>, Docker)`);
say(`geometry        : ${COLS} cols x ${ROWS} rows (BRIEF N2)`);
say(`seeds           : ${SEEDS.join(', ')}`);
say(`node            : ${process.version}`);
say('');
say('normalization applied (and NOTHING else):');
say('  - CRLF/CR -> LF');
say('  - trailing whitespace per line; trailing blank lines');
say('  - SGR escapes stripped FROM THE GOLDEN via /\\x1b\\[[0-9;-]*m/g');
say('    (tolerant of cbonsai\'s malformed ESC[3-1m, BRIEF N3 addendum)');
say('  characters are compared by code point; nothing else is touched.');
say('');

const results = [];

for (const seed of SEEDS) {
	const goldenPath = join(GOLDEN_DIR, `seed-${seed}.txt`);
	const plainPath = join(GOLDEN_DIR, `seed-${seed}.plain.txt`);

	say('-'.repeat(72));
	say(`SEED ${seed}`);
	say('-'.repeat(72));

	if (!existsSync(goldenPath)) {
		say(`  MATCH: NO  — golden file missing: ${goldenPath}`);
		results.push({ seed, match: false, reason: 'golden missing' });
		say('');
		continue;
	}

	// --- golden side -------------------------------------------------------
	const goldenRaw = readFileSync(goldenPath, 'utf8');
	const goldenGrid = normalizeToLines(stripSgr(goldenRaw));

	// Corroborate the strip against the independently captured plain grid.
	let stripCheck = 'plain-grid cross-check: SKIPPED (seed-<N>.plain.txt absent)';
	if (existsSync(plainPath)) {
		const plainGrid = normalizeToLines(readFileSync(plainPath, 'utf8'));
		const same =
			plainGrid.length === goldenGrid.length &&
			plainGrid.every((l, i) => l === goldenGrid[i]);
		stripCheck = same
			? 'plain-grid cross-check: OK (stripped seed-N.txt === seed-N.plain.txt)'
			: 'plain-grid cross-check: *** DISAGREES with seed-N.plain.txt ***';
	}

	// --- port side ---------------------------------------------------------
	let portText;
	let growth;
	try {
		// Run to completion: grow the whole tree, then take the final frame,
		// which is the state cbonsai's printstdscr() dumps.
		growth = growBonsai({ seed, rows: ROWS, cols: COLS });
		portText = growth.toPlainText(growth.finalFrame());
	} catch (err) {
		say(`  MATCH: NO  — port threw: ${err && err.stack ? err.stack : err}`);
		results.push({ seed, match: false, reason: 'port threw' });
		say('');
		continue;
	}
	const portGrid = normalizeToLines(portText);

	// --- diff --------------------------------------------------------------
	const cmp = compareGrids(portGrid, goldenGrid);

	// ---- STRICT CHECKS: zero normalization, so the normalization above can
	// never be what produces a pass. Two independent strict measures.

	// (a) Against the separately captured character grid, seed-<N>.plain.txt.
	//     This is a true byte-for-byte comparison: no stripping, no trimming,
	//     no line-ending rewriting. It is the strongest claim available.
	let bytesIdentical = null;
	let portSha = null;
	let plainSha = null;
	if (existsSync(plainPath)) {
		const portBuf = Buffer.from(portText, 'utf8');
		const plainBuf = readFileSync(plainPath);
		bytesIdentical = portBuf.equals(plainBuf);
		portSha = createHash('sha256').update(portBuf).digest('hex');
		plainSha = createHash('sha256').update(plainBuf).digest('hex');
	}

	// (b) Against seed-<N>.txt with SGR stripped and line endings unified, but
	//     NO whitespace trimming. printstdscr() ends with a final `ESC[0m\n`
	//     reset line (cbonsai.c:767) that collapses to a bare newline once SGR
	//     is gone, so an exact grid match legitimately shows up here as the
	//     golden being exactly one '\n' longer. That single byte is cbonsai's
	//     reset line, not a grid cell — and it is reported as such rather than
	//     quietly trimmed away.
	const strictPort = portText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const strictGold = stripSgr(goldenRaw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const strictEqual = strictPort === strictGold;
	const resetLineOnly = !strictEqual && strictGold === strictPort + '\n';

	say(`  golden grid   : ${goldenGrid.length} lines, widths ` +
		`${Math.min(...goldenGrid.map((l) => l.length))}..${Math.max(...goldenGrid.map((l) => l.length))}`);
	say(`  port grid     : ${portGrid.length} lines, widths ` +
		`${Math.min(...portGrid.map((l) => l.length))}..${Math.max(...portGrid.map((l) => l.length))}`);
	say(`  ${stripCheck}`);
	say(`  growth steps  : ${growth.stepCount}  branches: ${growth.branches}  shoots: ${growth.shoots}`);
	say('');
	say(`  EXACT MATCH   : ${cmp.equal ? 'YES' : 'NO'}`);
	say('');
	say('  strict checks (ZERO normalization):');
	if (bytesIdentical === null) {
		say('    vs seed-N.plain.txt : SKIPPED (file absent)');
	} else {
		say(`    vs seed-N.plain.txt : BYTE-FOR-BYTE ${bytesIdentical ? 'IDENTICAL' : 'DIFFERENT'}`);
		say(`      port   sha256 ${portSha}  (${Buffer.byteLength(portText, 'utf8')} bytes)`);
		say(`      golden sha256 ${plainSha}`);
	}
	if (strictEqual) {
		say('    vs seed-N.txt (SGR stripped, untrimmed) : IDENTICAL');
	} else if (resetLineOnly) {
		say('    vs seed-N.txt (SGR stripped, untrimmed) : identical except the golden');
		say('      carries one extra trailing "\\n" — printstdscr()\'s final ESC[0m reset');
		say('      line (cbonsai.c:767), which is not a grid cell. No cell differs.');
	} else {
		say('    vs seed-N.txt (SGR stripped, untrimmed) : DIFFERENT beyond the reset line');
		say(`      port ${strictPort.length} chars vs golden ${strictGold.length} chars`);
	}

	if (!cmp.equal) {
		say(`  cell mismatches: ${cmp.mismatches}` +
			(cmp.lineCountDiff ? `  (LINE COUNT DIFFERS: port ${portGrid.length} vs golden ${goldenGrid.length})` : ''));
		say(`  first differing line: ${cmp.firstLine + 1} (1-based), first differing column: ${cmp.firstCol + 1}`);
		say('');
		say(`    port  : |${cmp.gotLine}|`);
		say(`    golden: |${cmp.wantLine}|`);
		say(`             ${caretRuler(cmp.firstCol)}`);
		say('');
		say('    (spaces shown as ·)');
		say(`    port  : |${visible(cmp.gotLine)}|`);
		say(`    golden: |${visible(cmp.wantLine)}|`);
	}

	results.push({
		seed,
		match: cmp.equal,
		bytesIdentical,
		mismatches: cmp.mismatches,
		firstLine: cmp.firstLine + 1,
		firstCol: cmp.firstCol + 1,
	});
	say('');
}

// ----------------------------------------------------------------- summary

const matched = results.filter((r) => r.match).length;
say('='.repeat(72));
say('SUMMARY');
say('='.repeat(72));
for (const r of results) {
	const flag = r.match ? 'MATCH  ' : 'MISMATCH';
	const detail = r.match
		? ''
		: r.reason
			? `  (${r.reason})`
			: `  ${r.mismatches} cell(s), first at line ${r.firstLine} col ${r.firstCol}`;
	say(`  seed ${String(r.seed).padStart(10)} : ${flag}${detail}`);
}
say('');
say(`  ${matched} of ${results.length} seeds match the real cbonsai character grid exactly.`);
say(`  M1 fidelity gate: ${matched === results.length ? 'PASS' : 'FAIL'}`);
say('');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, report.join('\n') + '\n', 'utf8');
if (!quiet) console.log(`report written to ${outPath}`);

process.exit(matched === results.length ? 0 : 1);
