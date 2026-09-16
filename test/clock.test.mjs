/**
 * GrowthClock tests — plain `node --test`, no dependencies.
 *
 * Every test drives an injected virtual time source, so the whole suite runs
 * in milliseconds and proves the clock never reads a wall clock.
 *
 *   node --test test/clock.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GrowthClock,
  createGrowthClock,
  createHeadlessClock,
  parseParams,
  normalizedTime,
  phaseAt,
  clamp01,
  DEFAULTS,
  PHASES,
  BLOOM_START,
} from '../src/shared/clock.js';

/** A virtual time source: milliseconds we control by hand. */
function virtualTime(startMs = 0) {
  let ms = startMs;
  return {
    now: () => ms,
    set: (v) => {
      ms = v;
    },
    advanceSeconds: (s) => {
      ms += s * 1000;
    },
  };
}

// ---------------------------------------------------------------------------
// The three exact points the brief gates on: t = 0, 0.5, 1.0
// ---------------------------------------------------------------------------

test('t is exactly 0 at start', () => {
  const time = virtualTime(0);
  const clock = new GrowthClock({ now: time.now, raf: null });

  assert.strictEqual(clock.t, 0);
  assert.strictEqual(Object.is(clock.t, 0), true, 't must be +0, not -0');
  assert.strictEqual(clock.elapsed, 0);
  assert.strictEqual(clock.phase, 'seed');
  assert.strictEqual(clock.done, false);
});

test('t is exactly 0 at start regardless of the time source origin', () => {
  for (const origin of [0, 1, 1_000, 1_700_000_000_000, 123.456]) {
    const time = virtualTime(origin);
    const clock = new GrowthClock({ now: time.now, raf: null });
    assert.strictEqual(clock.t, 0, `origin ${origin}`);
  }
});

test('t is exactly 0.5 at the midpoint of the default 3600s duration', () => {
  const time = virtualTime(0);
  const clock = new GrowthClock({ now: time.now, raf: null });

  time.advanceSeconds(1800);
  const frame = clock.tick(time.now());

  assert.strictEqual(frame.t, 0.5);
  assert.strictEqual(frame.elapsed, 1800);
  assert.strictEqual(frame.remaining, 1800);
  assert.strictEqual(frame.done, false);
});

test('t is exactly 1.0 at the end', () => {
  const time = virtualTime(0);
  const clock = new GrowthClock({ now: time.now, raf: null });

  time.advanceSeconds(3600);
  const frame = clock.tick(time.now());

  assert.strictEqual(frame.t, 1);
  assert.strictEqual(frame.elapsed, 3600);
  assert.strictEqual(frame.remaining, 0);
  assert.strictEqual(frame.phase, 'bloom');
  assert.strictEqual(frame.done, true);
});

// ---------------------------------------------------------------------------
// Clamping: never loops, wraps, or exceeds 1
// ---------------------------------------------------------------------------

test('t clamps at 1.0 past the end and never wraps', () => {
  const head = createHeadlessClock({ duration: 3600 });

  head.advanceSeconds(3600);
  assert.strictEqual(head.sample().t, 1);

  for (const extra of [1, 60, 3600, 36_000, 3_600_000]) {
    const frame = head.advanceSeconds(extra);
    assert.strictEqual(frame.t, 1, `still 1 after +${extra}s`);
    assert.strictEqual(frame.elapsed, 3600, 'elapsed clamps to duration');
    assert.strictEqual(frame.remaining, 0);
    assert.strictEqual(frame.phase, 'bloom');
    assert.strictEqual(frame.done, true);
  }
});

test('t never exceeds 1 and never decreases across a full sampled run', () => {
  const head = createHeadlessClock({ duration: 3600 });
  let previous = head.sample().t;
  assert.strictEqual(previous, 0);

  // Walk 1.5x the duration in 3-second steps.
  for (let step = 1; step <= 1800; step += 1) {
    const { t } = head.advanceSeconds(3);
    assert.ok(t >= previous, `t went backwards at step ${step}: ${previous} -> ${t}`);
    assert.ok(t <= 1, `t exceeded 1 at step ${step}: ${t}`);
    assert.ok(t >= 0, `t went below 0 at step ${step}: ${t}`);
    previous = t;
  }
  assert.strictEqual(previous, 1);
});

test('the clock stops: the rAF loop is not rescheduled after t reaches 1', () => {
  const time = virtualTime(0);
  const scheduled = [];
  const raf = (cb) => {
    scheduled.push(cb);
    return scheduled.length; // a non-null id
  };
  const cancelled = [];
  const clock = new GrowthClock({
    duration: 60,
    now: time.now,
    raf,
    cancelRaf: (id) => cancelled.push(id),
  });

  const seen = [];
  clock.subscribe((frame) => seen.push(frame.t));

  // Immediate frame on subscribe, and exactly one frame requested.
  assert.deepStrictEqual(seen, [0]);
  assert.strictEqual(scheduled.length, 1);

  // Drive 6 frames of 10 virtual seconds each.
  for (let i = 0; i < 6; i += 1) {
    const cb = scheduled[scheduled.length - 1];
    time.advanceSeconds(10);
    cb();
  }

  assert.deepStrictEqual(seen, [0, 1 / 6, 2 / 6, 0.5, 4 / 6, 5 / 6, 1]);
  assert.strictEqual(seen.at(-1), 1);

  // 6 frames were consumed; the 6th (t === 1) must not have queued a 7th.
  assert.strictEqual(scheduled.length, 6, 'no frame scheduled after t reached 1');
  assert.strictEqual(clock.done, true);

  // And nothing re-arms it afterwards.
  clock.subscribe(() => {});
  assert.strictEqual(scheduled.length, 6, 'subscribing after the end must not restart the loop');
});

// ---------------------------------------------------------------------------
// Parameters: duration, speed, seed
// ---------------------------------------------------------------------------

test('duration param: a 60-second compressed run hits 0, 0.5, 1 exactly', () => {
  const time = virtualTime(0);
  const clock = new GrowthClock({ duration: 60, now: time.now, raf: null });

  assert.strictEqual(clock.t, 0);

  time.advanceSeconds(30);
  assert.strictEqual(clock.tick(time.now()).t, 0.5);

  time.advanceSeconds(30);
  const end = clock.tick(time.now());
  assert.strictEqual(end.t, 1);
  assert.strictEqual(end.elapsed, 60);
  assert.strictEqual(end.done, true);
});

test('speed param: speed=60 completes a 3600s run in 60 real seconds', () => {
  const time = virtualTime(0);
  const clock = new GrowthClock({ duration: 3600, speed: 60, now: time.now, raf: null });

  time.advanceSeconds(30); // 30 real seconds
  const mid = clock.tick(time.now());
  assert.strictEqual(mid.t, 0.5);
  assert.strictEqual(mid.elapsed, 1800, 'model seconds, not real seconds');
  assert.strictEqual(mid.realElapsed, 30);

  time.advanceSeconds(30);
  const end = clock.tick(time.now());
  assert.strictEqual(end.t, 1);
  assert.strictEqual(end.realElapsed, 60);
  assert.strictEqual(end.done, true);
});

test('speed param: speed=0.5 halves progress for the same real time', () => {
  const time = virtualTime(0);
  const clock = new GrowthClock({ duration: 3600, speed: 0.5, now: time.now, raf: null });

  time.advanceSeconds(1800);
  assert.strictEqual(clock.tick(time.now()).t, 0.25);

  time.advanceSeconds(5400);
  assert.strictEqual(clock.tick(time.now()).t, 1);
});

test('speed and duration combine: duration=60&speed=2 ends in 30 real seconds', () => {
  const head = createHeadlessClock({ duration: 60, speed: 2 });

  assert.strictEqual(head.advanceSeconds(15).t, 0.5);
  const end = head.advanceSeconds(15);
  assert.strictEqual(end.t, 1);
  assert.strictEqual(end.elapsed, 60);
  assert.strictEqual(end.realElapsed, 30);
});

test('seed is carried through to every frame', () => {
  const head = createHeadlessClock({ duration: 60, seed: 1337 });
  assert.strictEqual(head.clock.seed, 1337);
  assert.strictEqual(head.sample().seed, 1337);
  assert.strictEqual(head.advanceSeconds(30).seed, 1337);
  assert.strictEqual(createHeadlessClock({ seed: 0 }).clock.seed, 0, 'seed 0 is valid');
});

// ---------------------------------------------------------------------------
// URL parsing (N6)
// ---------------------------------------------------------------------------

test('parseParams defaults are duration=3600, speed=1, seed=42', () => {
  assert.deepStrictEqual(parseParams(''), { duration: 3600, speed: 1, seed: 42 });
  assert.deepStrictEqual(parseParams('?'), DEFAULTS);
  assert.deepStrictEqual(parseParams(undefined), DEFAULTS, 'no location in Node -> defaults');
});

test('parseParams reads ?duration=&speed=&seed=', () => {
  assert.deepStrictEqual(parseParams('?duration=60&speed=60&seed=7'), {
    duration: 60,
    speed: 60,
    seed: 7,
  });
  assert.deepStrictEqual(parseParams('duration=120&seed=-3'), {
    duration: 120,
    speed: 1,
    seed: -3,
  });
  assert.deepStrictEqual(
    parseParams(new URL('http://localhost:8080/index.html?duration=10&speed=2&seed=99')),
    { duration: 10, speed: 2, seed: 99 },
  );
  assert.deepStrictEqual(parseParams(new URLSearchParams({ duration: '5' })), {
    duration: 5,
    speed: 1,
    seed: 42,
  });
});

test('parseParams falls back to defaults on junk values', () => {
  const junk = ['?duration=abc&speed=&seed=', '?duration=0&speed=-4&seed=NaN', '?duration=-1'];
  for (const q of junk) {
    const parsed = parseParams(q);
    assert.strictEqual(parsed.duration, 3600, q);
    assert.strictEqual(parsed.speed, 1, q);
    assert.strictEqual(parsed.seed, 42, q);
  }
});

test('createGrowthClock builds from a query string; explicit options win', () => {
  const time = virtualTime(0);
  const clock = createGrowthClock({
    search: '?duration=60&speed=10&seed=7',
    now: time.now,
    raf: null,
  });
  assert.strictEqual(clock.duration, 60);
  assert.strictEqual(clock.speed, 10);
  assert.strictEqual(clock.seed, 7);

  time.advanceSeconds(3); // 3 real * 10 = 30 model seconds of 60
  assert.strictEqual(clock.tick(time.now()).t, 0.5);

  const override = createGrowthClock({
    search: '?duration=60',
    duration: 120,
    now: time.now,
    raf: null,
  });
  assert.strictEqual(override.duration, 120);
});

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

test('phases run seed -> sapling -> branching -> mature -> bloom', () => {
  assert.deepStrictEqual(
    PHASES.map((p) => p.name),
    ['seed', 'sapling', 'branching', 'mature', 'bloom'],
  );

  assert.strictEqual(phaseAt(0), 'seed');
  assert.strictEqual(phaseAt(0.079), 'seed');
  assert.strictEqual(phaseAt(0.08), 'sapling');
  assert.strictEqual(phaseAt(0.27), 'sapling');
  assert.strictEqual(phaseAt(0.28), 'branching');
  assert.strictEqual(phaseAt(0.61), 'branching');
  assert.strictEqual(phaseAt(0.62), 'mature');
  assert.strictEqual(phaseAt(BLOOM_START - 1e-9), 'mature');
  assert.strictEqual(phaseAt(BLOOM_START), 'bloom');
  assert.strictEqual(phaseAt(1), 'bloom');

  // Clamped inputs stay in range.
  assert.strictEqual(phaseAt(-5), 'seed');
  assert.strictEqual(phaseAt(42), 'bloom');
});

test('phases advance monotonically over a run and end in bloom', () => {
  const head = createHeadlessClock({ duration: 3600 });
  const order = PHASES.map((p) => p.name);
  let index = 0;

  for (let i = 0; i < 720; i += 1) {
    const frame = head.advanceSeconds(5);
    const seen = order.indexOf(frame.phase);
    assert.ok(seen >= index, `phase went backwards: ${order[index]} -> ${frame.phase}`);
    assert.ok(frame.phaseProgress >= 0 && frame.phaseProgress <= 1);
    index = seen;
  }
  assert.strictEqual(head.sample().phase, 'bloom');
  assert.strictEqual(head.sample().t, 1);
});

// ---------------------------------------------------------------------------
// Determinism and injectability
// ---------------------------------------------------------------------------

test('same params + same time sequence -> identical frames (deterministic)', () => {
  const run = () => {
    const head = createHeadlessClock({ duration: 600, speed: 3, seed: 42 });
    const frames = [];
    for (let i = 0; i < 100; i += 1) frames.push(head.advanceSeconds(2.5));
    return frames;
  };

  const a = run();
  const b = run();
  assert.deepStrictEqual(
    a.map((f) => [f.t, f.elapsed, f.phase, f.done]),
    b.map((f) => [f.t, f.elapsed, f.phase, f.done]),
  );
  assert.strictEqual(a.at(-1).t, 1);
});

test('no wall-clock reads: sampling repeatedly without advancing never changes t', () => {
  const head = createHeadlessClock({ duration: 3600 });
  head.advanceSeconds(900);
  const t = head.sample().t;
  assert.strictEqual(t, 0.25);

  const busyUntil = Date.now() + 25; // real time genuinely passes here
  while (Date.now() < busyUntil) {
    /* spin */
  }

  assert.strictEqual(head.sample().t, t, 'real time passing must not move the clock');
  assert.strictEqual(head.clock.t, t);
});

test('frames are immutable and downstream growth cannot mutate the clock', () => {
  const head = createHeadlessClock({ duration: 60 });
  const frame = head.advanceSeconds(30);
  assert.strictEqual(Object.isFrozen(frame), true);
  assert.throws(() => {
    'use strict';
    frame.t = 0.9;
  }, TypeError);
  assert.strictEqual(head.sample().t, 0.5);
});

test('a time source that jumps backwards cannot rewind growth', () => {
  const time = virtualTime(0);
  const clock = new GrowthClock({ duration: 60, now: time.now, raf: null });

  time.advanceSeconds(30);
  assert.strictEqual(clock.tick(time.now()).t, 0.5);

  time.set(-10_000); // hostile / adjusted clock
  assert.strictEqual(clock.tick(time.now()).t, 0.5, 't must hold, not rewind');

  time.set(60_000);
  assert.strictEqual(clock.tick(time.now()).t, 1);
});

test('pause holds t; resume does not credit paused time', () => {
  const time = virtualTime(0);
  const clock = new GrowthClock({ duration: 60, now: time.now, raf: null });

  time.advanceSeconds(15);
  assert.strictEqual(clock.tick(time.now()).t, 0.25);

  clock.pause(time.now());
  time.advanceSeconds(120);
  assert.strictEqual(clock.sample(time.now()).t, 0.25, 'paused clock holds');

  clock.resume(time.now());
  time.advanceSeconds(15);
  assert.strictEqual(clock.tick(time.now()).t, 0.5);
});

// ---------------------------------------------------------------------------
// subscribe()
// ---------------------------------------------------------------------------

test('subscribe fires immediately, then per frame, and unsubscribe stops it', () => {
  const time = virtualTime(0);
  let pending = null;
  const clock = new GrowthClock({
    duration: 100,
    now: time.now,
    raf: (cb) => {
      pending = cb;
      return 1;
    },
    cancelRaf: () => {
      pending = null;
    },
  });

  const seen = [];
  const unsubscribe = clock.subscribe((f) => seen.push(f.t));
  assert.deepStrictEqual(seen, [0], 'immediate first frame');

  time.advanceSeconds(25);
  pending();
  assert.deepStrictEqual(seen, [0, 0.25]);

  unsubscribe();
  assert.strictEqual(pending, null, 'loop cancelled when the last subscriber leaves');

  time.advanceSeconds(25);
  assert.deepStrictEqual(seen, [0, 0.25], 'no frames after unsubscribe');
  assert.strictEqual(clock.sample(time.now()).t, 0.5, 'the clock itself kept running');
});

test('both panels subscribed to one clock see the identical frame', () => {
  const time = virtualTime(0);
  let pending = null;
  const clock = new GrowthClock({
    duration: 3600,
    now: time.now,
    raf: (cb) => {
      pending = cb;
      return 1;
    },
  });

  const ascii = [];
  const blender = [];
  clock.subscribe((f) => ascii.push(f));
  clock.subscribe((f) => blender.push(f));

  for (let i = 0; i < 5; i += 1) {
    time.advanceSeconds(360);
    pending();
  }

  assert.strictEqual(ascii.length, blender.length);
  assert.strictEqual(ascii.length, 6, 'one immediate frame + five broadcast frames');

  // The immediate on-subscribe frame is sampled per subscriber: equal values,
  // separate objects.
  assert.notStrictEqual(ascii[0], blender[0]);
  assert.deepStrictEqual(ascii[0], blender[0]);

  // Every broadcast frame is the *same* frozen object for both panels, so the
  // two sides cannot drift by even one float.
  for (let i = 1; i < ascii.length; i += 1) {
    assert.strictEqual(ascii[i], blender[i], `frame ${i}: same object, zero sync drift`);
  }
  assert.strictEqual(ascii.at(-1).t, 0.5);
});

test('subscribe rejects a non-function', () => {
  const clock = new GrowthClock({ now: () => 0, raf: null });
  assert.throws(() => clock.subscribe(null), TypeError);
  assert.throws(() => clock.subscribe(123), TypeError);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('normalizedTime and clamp01 are exact and clamped', () => {
  assert.strictEqual(normalizedTime(0, 3600), 0);
  assert.strictEqual(normalizedTime(1800, 3600), 0.5);
  assert.strictEqual(normalizedTime(3600, 3600), 1);
  assert.strictEqual(normalizedTime(7200, 3600), 1);
  assert.strictEqual(normalizedTime(-5, 3600), 0);
  assert.strictEqual(normalizedTime(30, 60), 0.5);

  assert.strictEqual(clamp01(-1), 0);
  assert.strictEqual(clamp01(0), 0);
  assert.strictEqual(clamp01(0.5), 0.5);
  assert.strictEqual(clamp01(1), 1);
  assert.strictEqual(clamp01(2), 1);
  assert.strictEqual(clamp01(Number.NaN), 0);
  assert.strictEqual(clamp01(Number.POSITIVE_INFINITY), 1);
});
