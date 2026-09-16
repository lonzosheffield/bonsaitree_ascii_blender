#!/usr/bin/env node
// Verify the rendered frame ladder against public/frames/manifest.json.
// Dependency-free and Node-only on purpose: the README promises that running
// this project needs nothing but Node, so its troubleshooting tool must too.
//
//   node tools/verify-frames.mjs          check count, names and file sizes
//   node tools/verify-frames.mjs --hash   also re-verify every sha256 (slower)

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAMES = join(ROOT, 'public', 'frames');
const withHash = process.argv.includes('--hash');

const fail = [];
const note = (m) => console.log(m);

let manifest;
try {
  manifest = JSON.parse(await readFile(join(FRAMES, 'manifest.json'), 'utf8'));
} catch (err) {
  console.error(`FAIL  cannot read public/frames/manifest.json (${err.code ?? err.message})`);
  console.error('      The frame ladder is missing. Regenerate it with blender/bonsai_growth.py');
  console.error('      (requires Blender 5.2; takes ~68 minutes).');
  process.exit(1);
}

const entries = manifest.frames ?? manifest.files ?? [];
const expected = manifest.frameCount ?? manifest.count ?? entries.length;
note(`manifest: ${expected} frames expected${manifest.resolution ? `, ${manifest.resolution}` : ''}`);

const present = new Set((await readdir(FRAMES)).filter((f) => f.endsWith('.jpg')));
note(`on disk : ${present.size} jpg files`);

if (present.size !== expected) {
  fail.push(`frame count mismatch: expected ${expected}, found ${present.size}`);
}

let checked = 0;
for (const entry of entries) {
  const name = typeof entry === 'string' ? entry : entry.file ?? entry.name;
  if (!name) continue;
  const path = join(FRAMES, name);

  if (!present.has(name)) {
    fail.push(`missing: ${name}`);
    continue;
  }

  const size = (await stat(path)).size;
  if (size === 0) {
    fail.push(`zero-byte: ${name}`);
    continue;
  }
  const want = typeof entry === 'object' ? entry.bytes ?? entry.size : undefined;
  if (want !== undefined && size !== want) {
    fail.push(`size mismatch: ${name} is ${size} B, manifest says ${want} B`);
    continue;
  }

  if (withHash && typeof entry === 'object' && entry.sha256) {
    const got = createHash('sha256').update(await readFile(path)).digest('hex');
    if (got !== entry.sha256) fail.push(`sha256 mismatch: ${name}`);
  }
  checked++;
}

note(`checked : ${checked} frames${withHash ? ' (with sha256)' : ''}`);

if (fail.length === 0) {
  console.log('\nOK  the frame ladder is complete and intact.');
  process.exit(0);
}

console.error(`\nFAIL  ${fail.length} problem(s):`);
for (const f of fail.slice(0, 20)) console.error(`  - ${f}`);
if (fail.length > 20) console.error(`  ... and ${fail.length - 20} more`);
console.error('\nRegenerate the ladder with blender/bonsai_growth.py (Blender 5.2, ~68 min).');
process.exit(1);
