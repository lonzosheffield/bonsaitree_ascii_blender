// Simulate the browser globals the module reaches for, then import it.
globalThis.location = { search: '?duration=60&speed=60&seed=7' };
let vnow = 0, queue = [], id = 0;
globalThis.performance = { now: () => vnow };
globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return ++id; };
globalThis.cancelAnimationFrame = () => {};

const { createGrowthClock } = await import('../../src/shared/clock.js');
const clock = createGrowthClock();           // no options at all: pure URL path
console.log('params from location:', clock.duration, clock.speed, clock.seed);

const seen = [];
clock.subscribe(f => seen.push(`${f.t.toFixed(4)} ${f.phase}`));
for (let i = 0; i < 12 && queue.length; i++) { const cb = queue.pop(); vnow += 100; cb(); }
console.log('frames:', seen.join(' | '));
console.log('rAF still queued after t=1:', queue.length, '| done:', clock.done, '| t:', clock.t);
