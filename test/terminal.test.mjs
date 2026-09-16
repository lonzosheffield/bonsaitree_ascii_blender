/**
 * Terminal renderer tests — plain `node --test`, no dependencies.
 *
 * The renderer is a DOM consumer, so the suite supplies the smallest DOM that
 * can hold it: elements that record `innerHTML` and can read their own text
 * back. That is enough to assert the three things the panel is gated on —
 * 80x40 geometry (N2), the cbonsai palette per cell, and monotonic growth
 * driven only by `t` (N6) — against the REAL golden captures in proof/M1.
 *
 *   node --test test/terminal.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  TerminalRenderer,
  mountTerminal,
  cellClass,
  escapeText,
  rowHtml,
  xterm256Hex,
  boldHex,
} from '../src/ascii/terminal.js';
import { growBonsai } from '../src/ascii/bonsai.js';

const GOLDEN = fileURLToPath(new URL('../proof/M1/golden/', import.meta.url));
const SEEDS = [1, 42, 1337, 99999, 2147483647];

// ---------------------------------------------------------------------------
// The smallest DOM that can hold the renderer
// ---------------------------------------------------------------------------

let htmlWrites = 0;

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = text;
  }
}

class FakeElement {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.dataset = {};
    this.className = '';
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  }
  appendChild(node) {
    if (node instanceof FakeFragment) {
      this.childNodes.push(...node.childNodes);
      node.childNodes = [];
    } else {
      this.childNodes.push(node);
    }
    return node;
  }
  remove() {
    this.removed = true;
  }
  set textContent(v) {
    this.childNodes = v === '' ? [] : [new FakeText(v)];
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set innerHTML(html) {
    htmlWrites++;
    this._html = html;
    this.childNodes = parseSpans(html, this.ownerDocument);
  }
  get innerHTML() {
    return this._html || '';
  }
}

class FakeFragment {
  constructor() {
    this.childNodes = [];
  }
  appendChild(node) {
    this.childNodes.push(node);
    return node;
  }
}

/** The renderer emits only `<span class="...">text</span>` and bare text. */
function parseSpans(html, doc) {
  const out = [];
  const re = /<span class="([^"]*)">([^<]*)<\/span>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (m[3] !== undefined) {
      out.push(new FakeText(unescape(m[3])));
      continue;
    }
    const el = new FakeElement('span', doc);
    el.className = m[1];
    el.childNodes = [new FakeText(unescape(m[2]))];
    out.push(el);
  }
  return out;
}

function fakeDocument() {
  const doc = {
    readyState: 'complete',
    createElement: (t) => new FakeElement(t, doc),
    createDocumentFragment: () => new FakeFragment(),
    createTextNode: (t) => new FakeText(t),
    getElementById: (id) => (id === 'tree' ? doc._tree : null),
    querySelector: (sel) => (sel === '[data-placeholder-note="ascii"]' ? doc._note : null),
  };
  doc._tree = new FakeElement('pre', doc);
  doc._tree.dataset.placeholder = 'true';
  doc._note = new FakeElement('p', doc);
  doc.defaultView = {
    location: { search: '' },
    addEventListener() {},
    removeEventListener() {},
    console,
  };
  return doc;
}

/** The painted grid, read back out of the DOM as rows of text. */
function paintedRows(el) {
  return el.childNodes.filter((n) => n.nodeType === 1).map((r) => r.textContent);
}

/** The class name of every cell, read back out of the DOM. */
function paintedClasses(el) {
  return el.childNodes
    .filter((n) => n.nodeType === 1)
    .map((row) => {
      const cells = [];
      for (const child of row.childNodes) {
        const cls = child.nodeType === 1 ? child.className : '';
        for (let i = 0; i < child.textContent.length; i++) cells.push(cls);
      }
      return cells;
    });
}

function newRenderer(options = {}) {
  const doc = fakeDocument();
  return { doc, renderer: new TerminalRenderer(doc._tree, options) };
}

// ---------------------------------------------------------------------------
// N2 — geometry
// ---------------------------------------------------------------------------

test('the grid is exactly 80x40 at every t', () => {
  const { doc, renderer } = newRenderer({ seed: 42 });
  for (let i = 0; i <= 200; i++) {
    renderer.renderAt(i / 200);
    const rows = paintedRows(doc._tree);
    assert.equal(rows.length, 40);
    for (const row of rows) assert.equal(row.length, 80, `row width at t=${i / 200}`);
  }
});

test('the <pre> holds 79 structural nodes, not 3200 cells', () => {
  const { doc, renderer } = newRenderer({ seed: 42 });
  renderer.renderFinal();
  // 40 row spans + the 39 newlines between them.
  assert.equal(doc._tree.childNodes.length, 79);
  assert.equal(paintedRows(doc._tree).length, 40);
});

// ---------------------------------------------------------------------------
// N3 — the painted grid IS the golden grid
// ---------------------------------------------------------------------------

for (const seed of SEEDS) {
  test(`seed ${seed} paints proof/M1/golden/seed-${seed}.plain.txt exactly at t=1`, () => {
    const { renderer } = newRenderer({ seed });
    renderer.renderAt(1);
    const golden = fs.readFileSync(`${GOLDEN}seed-${seed}.plain.txt`, 'utf8');
    assert.equal(renderer.text() + '\n', golden);
  });
}

test('same seed twice gives an identical grid at the same t', () => {
  const a = newRenderer({ seed: 1337 }).renderer;
  const b = newRenderer({ seed: 1337 }).renderer;
  a.renderAt(0.42);
  b.renderAt(0.42);
  assert.equal(a.text(), b.text());
});

// ---------------------------------------------------------------------------
// The palette, checked against the golden SGR stream rather than against us
// ---------------------------------------------------------------------------

/** Decode `printstdscr()`'s per-cell `bold + colour` stream from a golden. */
function goldenCells(seed) {
  const raw = fs.readFileSync(`${GOLDEN}seed-${seed}.txt`, 'latin1');
  const cells = [];
  let i = 0;
  while (i < raw.length) {
    const bold = /^\x1b\[(1|0)m/.exec(raw.slice(i, i + 5));
    if (!bold) {
      i++;
      continue;
    }
    let j = i + bold[0].length;
    // cbonsai.c:745-748, including the malformed ESC[3-1m for fg == -1.
    const col = /^\x1b\[(?:(0)m|38;5;(\d+)m|3(-1|[0-7])m|9([0-7])m)/.exec(raw.slice(j, j + 12));
    if (!col) {
      i = j;
      continue;
    }
    let fg;
    if (col[1] !== undefined) fg = 0;
    else if (col[2] !== undefined) fg = Number(col[2]);
    else if (col[3] !== undefined) fg = Number(col[3]);
    else fg = Number(col[4]) + 8;
    j += col[0].length;
    cells.push({ bold: bold[1] === '1', fg, ch: raw[j] });
    i = j + 1;
  }
  return cells;
}

/** cbonsai's default `-k 2,3,10,11` plus COLOR_TEXT = 8, as class names. */
const FG_CLASS = { '-1': '', 2: 'leaf-dark', 3: 'wood-dark', 8: 'txt', 10: 'leaf-bright', 11: 'wood-bright' };

test('every cell carries the colour the real cbonsai gave it', () => {
  const { doc, renderer } = newRenderer({ seed: 42 });
  renderer.renderAt(1);
  const painted = paintedClasses(doc._tree);
  const cells = goldenCells(42);
  assert.equal(cells.length, 3200, 'golden decodes to one entry per cell');

  let coloured = 0;
  let bold = 0;
  for (let k = 0; k < cells.length; k++) {
    const { fg, bold: isBold } = cells[k];
    const name = FG_CLASS[fg];
    assert.notEqual(name, undefined, `unexpected golden fg ${fg}`);
    const want = isBold ? (name ? `b ${name}` : 'b') : name;
    assert.equal(painted[Math.floor(k / 80)][k % 80], want, `class at cell ${k}`);
    if (name) coloured++;
    if (name && isBold) bold++;
  }
  // Guard the guard: a palette check that matched only blanks would pass above.
  assert.ok(coloured > 250, `expected a coloured tree, got ${coloured} coloured cells`);
  assert.ok(bold > 50, `expected A_BOLD cells, got ${bold}`);
});

test('cellClass maps pairs and A_BOLD onto the stylesheet contract', () => {
  assert.equal(cellClass(0, 0), '');
  assert.equal(cellClass(1, 0), 'leaf-dark');
  assert.equal(cellClass(2, 0), 'wood-dark');
  assert.equal(cellClass(3, 0), 'leaf-bright');
  assert.equal(cellClass(4, 1), 'b wood-bright');
  assert.equal(cellClass(5, 1), 'b txt');
});

test('a non-default -k palette is resolved from the xterm-256 table', () => {
  assert.equal(xterm256Hex(2), '#008000');
  assert.equal(xterm256Hex(10), '#00ff00');
  assert.equal(xterm256Hex(196), '#ff0000');
  assert.equal(xterm256Hex(232), '#080808');
  // The relationship the shipped tokens in src/styles.css encode.
  assert.equal(boldHex(2), '#00c000');
  assert.equal(boldHex(10), '#9cff9c');

  const { doc } = newRenderer({ seed: 42, growOptions: { colors: [1, 4, 9, 12] } });
  assert.equal(doc._tree.style.props['--cb-leaf-dark'], '#800000');
  assert.equal(doc._tree.style.props['--cb-wood-bright'], '#0000ff');

  // The default palette must leave the stylesheet alone — it is the gated one.
  const plain = newRenderer({ seed: 42 });
  assert.deepEqual(plain.doc._tree.style.props, {});
});

test("the '&' leaf is escaped", () => {
  assert.equal(escapeText('&&&'), '&amp;&amp;&amp;');
  assert.equal(escapeText('<&>'), '&lt;&amp;&gt;');
  assert.equal(escapeText('/|\\'), '/|\\');

  const frame = growBonsai({ seed: 42 }).finalFrame();
  const leafRow = frame.lines.findIndex((line) => line.includes('&'));
  assert.ok(leafRow >= 0, 'the finished tree has leaves');
  const html = rowHtml(frame, leafRow);
  assert.ok(html.includes('&amp;'));
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(html));
});

// ---------------------------------------------------------------------------
// N6 — growth is a monotonic function of t, and cheap
// ---------------------------------------------------------------------------

test('growth is monotonic: no drawn cell is ever erased', () => {
  const { doc, renderer } = newRenderer({ seed: 99999 });
  let prev = null;
  for (let i = 0; i <= 400; i++) {
    renderer.renderAt(i / 400);
    const rows = paintedRows(doc._tree);
    if (prev) {
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 80; x++) {
          if (prev[y][x] !== ' ') {
            assert.notEqual(rows[y][x], ' ', `cell (${y},${x}) erased at t=${i / 400}`);
          }
        }
      }
    }
    prev = rows;
  }
});

test('the tree only ever grows, even if t runs backwards', () => {
  const { renderer } = newRenderer({ seed: 42 });
  renderer.renderAt(1);
  const bloom = renderer.text();
  renderer.renderAt(0);
  renderer.renderAt(0.25);
  assert.equal(renderer.step, renderer.stepCount);
  assert.equal(renderer.text(), bloom);
});

test('a tick that does not change the step touches no DOM', () => {
  const { renderer } = newRenderer({ seed: 42 });
  renderer.renderAt(0.5);
  htmlWrites = 0;
  // 600 frames' worth of ticks inside one step: at 3600s and 512 steps, this is
  // what the overwhelming majority of a 60fps run looks like.
  for (let i = 0; i < 600; i++) {
    assert.equal(renderer.renderAt(0.5 + i * 1e-7), false);
  }
  assert.equal(htmlWrites, 0);
});

test('a growth step rewrites only the rows it changed', () => {
  const { renderer } = newRenderer({ seed: 42 });
  htmlWrites = 0;
  for (let s = 0; s <= renderer.stepCount; s++) renderer.renderStep(s);
  // 40 rows x 513 steps would be 20520 writes; one or two rows per step is the
  // whole point of the row cache.
  assert.ok(
    htmlWrites < renderer.stepCount * 4,
    `${htmlWrites} row writes for ${renderer.stepCount} steps`,
  );
});

test('t=0 is a seed: the pot is drawn, the tree is not', () => {
  const { doc, renderer } = newRenderer({ seed: 42 });
  renderer.renderAt(0);
  const rows = paintedRows(doc._tree);
  assert.equal(renderer.step, 0);
  // Base art occupies the bottom 4 rows (N2 addendum); everything above is blank.
  for (let y = 0; y < 36; y++) assert.equal(rows[y].trim(), '', `row ${y} should be empty at t=0`);
  assert.ok(rows.slice(36).join('').trim().length > 0, 'the pot is drawn at t=0');
});

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

test('mountTerminal takes #tree over and follows the clock', () => {
  const doc = fakeDocument();
  let emit = null;
  let unsubscribed = false;
  const clock = {
    subscribe(cb) {
      emit = cb;
      cb({ t: 0 });
      return () => {
        unsubscribed = true;
      };
    },
  };

  const handle = mountTerminal({ document: doc, clock, seed: 42 });

  assert.equal(doc._tree.dataset.placeholder, undefined, 'data-placeholder cleared');
  assert.equal(doc._tree.dataset.seed, '42');
  assert.equal(doc._note.removed, true, 'the placeholder note is gone');

  emit({ t: 0.5 });
  const half = handle.renderer.step;
  assert.ok(half > 0 && half < handle.renderer.stepCount);

  emit({ t: 1 });
  assert.equal(handle.renderer.step, handle.renderer.stepCount);
  assert.equal(
    handle.renderer.text() + '\n',
    fs.readFileSync(`${GOLDEN}seed-42.plain.txt`, 'utf8'),
  );

  handle.stop();
  assert.equal(unsubscribed, true);
});

test('mountTerminal reads the seed from the shell when it is not given one', () => {
  const doc = fakeDocument();
  const handle = mountTerminal({
    document: doc,
    clock: { subscribe: () => () => {} },
    duet: { params: { duration: 60, speed: 60, seed: 1337 } },
  });
  assert.equal(handle.growth.seed, 1337);
  handle.renderer.renderFinal();
  assert.equal(
    handle.renderer.text() + '\n',
    fs.readFileSync(`${GOLDEN}seed-1337.plain.txt`, 'utf8'),
  );
});
