/**
 * M4 soak runner — drives the real page in headless Chrome over CDP and
 * samples it on a fixed cadence.
 *
 * Usage (real soak):
 *   node proof/M4/soak-runner.mjs
 * Usage (harness preflight, compressed):
 *   node proof/M4/soak-runner.mjs --preflight
 *
 * Everything it measures comes from the live page: the clock's own `t`, the
 * ASCII renderer's step index, the plate's frame window, Chrome's heap, the
 * page's PerformanceObserver longtask stream, and CDP's console/log channels.
 * Elapsed time is the RUNNER's own wall clock, deliberately independent of the
 * page, so DRIFT is a real comparison and not a tautology.
 */
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CDP, launchChrome, newPage, evaluate } from './cdp.mjs';

const PREFLIGHT = process.argv.includes('--preflight');
const HEADLESS = !process.argv.includes('--headed');

const CFG = PREFLIGHT
	? {
			tag: 'preflight',
			pageDuration: 3600,
			speed: 40, // 3600 model seconds in 90 real seconds
			soakSeconds: 90,
			sampleEvery: 10,
			hideAt: 30,
			hideFor: 12,
			shotAt: [0, 22.5, 45, 67.5],
			logFile: path.join(import.meta.dirname, 'preflight-log.txt'),
			jsonFile: path.join(import.meta.dirname, 'preflight-samples.jsonl'),
			shotDir: path.join(import.meta.dirname, 'preflight'),
			shotPrefix: 'pre',
		}
	: {
			tag: 'soak',
			pageDuration: 3600,
			speed: 1,
			soakSeconds: 3600,
			sampleEvery: 60,
			hideAt: 1200,
			hideFor: 70,
			shotAt: [0, 900, 1800, 2700],
			logFile: path.join(import.meta.dirname, 'soak-log.txt'),
			jsonFile: path.join(import.meta.dirname, 'soak-samples.jsonl'),
			shotDir: import.meta.dirname,
			shotPrefix: 'bloom',
		};

const PORT = Number(process.env.PORT || 8137);
const DEBUG_PORT = PREFLIGHT ? 9333 : 9334;
const URL_ = `http://127.0.0.1:${PORT}/?duration=${CFG.pageDuration}${
	CFG.speed !== 1 ? `&speed=${CFG.speed}` : ''
}&seed=42`;

mkdirSync(CFG.shotDir, { recursive: true });
writeFileSync(CFG.jsonFile, '');

function log(line) {
	process.stdout.write(line + '\n');
	appendFileSync(CFG.logFile, line + '\n');
}
function jlog(obj) {
	appendFileSync(CFG.jsonFile, JSON.stringify(obj) + '\n');
}
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').replace('Z', 'Z');
const f = (n, d = 3) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(d));
const mb = (bytes) => (bytes === null || bytes === undefined ? '—' : (bytes / 1048576).toFixed(2));

/* --------------------------------------------------------------------------
   In-page instrumentation. Installed before any page script runs.
   -------------------------------------------------------------------------- */
const INSTRUMENT = `
(() => {
  if (window.__soak) return;
  const s = {
    longTasks: 0, longTaskMs: 0, longTaskMax: 0,
    rafCalls: 0, rafFires: 0, lastFire: -1, maxGap: 0,
    visLog: [], bodyStates: [], plateStates: [],
    rec: null
  };
  window.__soak = s;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  s.nativeRaf = nativeRaf;
  window.requestAnimationFrame = function (cb) {
    s.rafCalls++;
    return nativeRaf(function (ts) {
      s.rafFires++;
      const n = performance.now();
      if (s.lastFire >= 0) { const g = n - s.lastFire; if (g > s.maxGap) s.maxGap = g; }
      s.lastFire = n;
      return cb(ts);
    });
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        s.longTasks++; s.longTaskMs += e.duration;
        if (e.duration > s.longTaskMax) s.longTaskMax = e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { s.longTaskError = String(e); }

  document.addEventListener('visibilitychange', () => {
    s.visLog.push({ perf: performance.now(), wall: Date.now(), state: document.visibilityState });
  });

  const watch = () => {
    const body = document.body;
    const stage = document.getElementById('blender-stage');
    if (!body) return;
    const push = (arr, v) => { if (!arr.length || arr[arr.length - 1].v !== v) arr.push({ v, wall: Date.now() }); };
    push(s.bodyStates, body.dataset.state);
    if (stage) push(s.plateStates, stage.dataset.state);
    new MutationObserver(() => push(s.bodyStates, body.dataset.state))
      .observe(body, { attributes: true, attributeFilter: ['data-state'] });
    if (stage) new MutationObserver(() => push(s.plateStates, stage.dataset.state))
      .observe(stage, { attributes: true, attributeFilter: ['data-state'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
  else watch();

  // N8 recovery recorder: armed while the tab is hidden, so its first sample is
  // the first animation frame after the tab comes back.
  window.__armRecovery = function (ms) {
    const out = { armedWall: Date.now(), samples: [], done: false };
    s.rec = out;
    let t0 = -1;
    const step = () => {
      const now = performance.now();
      if (t0 < 0) t0 = now;
      const p = window.BonsaiPlate && window.BonsaiPlate.panel ? window.BonsaiPlate.panel.stats() : null;
      const term = window.BonsaiTerminal;
      const imgs = Array.from(document.querySelectorAll('#blender-stage img')).map((el) => ({
        src: el.getAttribute('src'),
        op: Number(el.style.opacity || '0'),
        complete: el.complete,
        nw: el.naturalWidth,
      }));
      const painted = imgs.some((i) => i.op > 0 && i.complete && i.nw > 0 && i.src);
      out.samples.push({
        dt: +(now - t0).toFixed(1), wall: Date.now(),
        t: window.BonsaiDuet ? window.BonsaiDuet.clock.sample().t : null,
        step: term ? term.renderer.step : null,
        lo: p ? p.lo : null, hi: p ? p.hi : null, frac: p ? +p.frac.toFixed(4) : null,
        base: p ? p.baseIndex : null, top: p ? p.topIndex : null,
        baseOp: p ? p.baseOpacity : null, topOp: p ? p.topOpacity : null,
        state: p ? p.state : null, recovering: p ? p.recovering : null,
        painted, imgs,
      });
      if (now - t0 < ms) nativeRaf(step); else out.done = true;
    };
    nativeRaf(step);
    return true;
  };
})();
`;

/* --------------------------------------------------------------------------
   The per-sample probe.
   -------------------------------------------------------------------------- */
const PROBE = `
(() => {
  const D = window.BonsaiDuet;
  const clock = D && D.clock;
  const live = clock ? clock.sample() : null;
  const last = clock ? clock.lastFrame : null;
  const term = window.BonsaiTerminal;
  const plate = window.BonsaiPlate && window.BonsaiPlate.panel ? window.BonsaiPlate.panel.stats() : null;
  const s = window.__soak || {};
  const m = performance.memory || null;
  const fill = document.getElementById('timeline-fill');
  return {
    wall: Date.now(), perf: performance.now(),
    visibility: document.visibilityState,
    t: live ? live.t : null,
    tRendered: last ? last.t : null,
    realElapsed: live ? live.realElapsed : null,
    modelElapsed: live ? live.elapsed : null,
    phase: live ? live.phase : null,
    done: live ? live.done : null,
    clockDone: clock ? clock.done : null,
    started: clock ? clock.started : null,
    step: term ? term.renderer.step : null,
    stepCount: term ? term.renderer.stepCount : null,
    lo: plate ? plate.lo : null,
    hi: plate ? plate.hi : null,
    frac: plate ? plate.frac : null,
    baseIndex: plate ? plate.baseIndex : null,
    topIndex: plate ? plate.topIndex : null,
    plateState: plate ? plate.state : null,
    frameCount: plate ? plate.frameCount : null,
    cacheHeld: plate ? plate.held : null,
    cacheBytes: plate ? plate.heldBytes : null,
    cacheFetched: plate ? plate.stats.fetched : null,
    cacheEvicted: plate ? plate.stats.evicted : null,
    cacheFailed: plate ? plate.stats.failed : null,
    cacheDecodes: plate ? plate.stats.decodes : null,
    bodyState: document.body ? document.body.dataset.state : null,
    bodySettled: document.body ? document.body.dataset.settled : null,
    fillWidth: fill ? fill.style.width : null,
    longTasks: s.longTasks | 0,
    longTaskMs: +(s.longTaskMs || 0).toFixed(1),
    longTaskMax: +(s.longTaskMax || 0).toFixed(1),
    rafCalls: s.rafCalls | 0,
    rafFires: s.rafFires | 0,
    maxRafGap: +(s.maxGap || 0).toFixed(1),
    heapUsed: m ? m.usedJSHeapSize : null,
    heapTotal: m ? m.totalJSHeapSize : null,
    domNodes: document.getElementsByTagName('*').length,
  };
})()
`;

/* -------------------------------------------------------------------------- */

async function main() {
	log('');
	log('='.repeat(78));
	log(`M4 ${CFG.tag.toUpperCase()} — start ${iso()}`);
	log(`URL            ${URL_}`);
	log(`Browser        Chrome ${HEADLESS ? 'HEADLESS (--headless=new)' : 'HEADED (visible window)'}`);
	log(`Plan           ${CFG.soakSeconds}s run, sample every ${CFG.sampleEvery}s, hide at`);
	log(`               t+${CFG.hideAt}s for ${CFG.hideFor}s, screenshots at [${CFG.shotAt.join(', ')}]s + end`);
	log('='.repeat(78));

	const userDataDir = path.join(tmpdir(), `bonsai-soak-${CFG.tag}-${Date.now()}`);
	const { proc, version } = await launchChrome({
		port: DEBUG_PORT,
		userDataDir,
		headless: HEADLESS,
		windowSize: '1600,1000',
	});
	log(`Chrome         ${version.Browser}`);
	log(`User agent     ${version['User-Agent']}`);

	const cdp = await CDP.connect(version.webSocketDebuggerUrl);

	/* ---- console / error plumbing ---------------------------------------- */
	const counters = { consoleErrors: 0, consoleWarnings: 0, exceptions: 0, logErrors: 0, logWarnings: 0 };
	const messages = [];
	const record = (kind, text, extra) => {
		messages.push({ wall: Date.now(), kind, text: String(text).slice(0, 600), ...extra });
	};

	const { targetId, sessionId } = await newPage(cdp, 'about:blank');
	await cdp.send('Runtime.enable', {}, sessionId);
	await cdp.send('Log.enable', {}, sessionId);
	await cdp.send('Page.enable', {}, sessionId);

	cdp.on('Runtime.consoleAPICalled', (p, sid) => {
		if (sid !== sessionId) return;
		const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
		if (p.type === 'error' || p.type === 'assert') {
			counters.consoleErrors++;
			record('console.error', text);
		} else if (p.type === 'warning') {
			counters.consoleWarnings++;
			record('console.warn', text);
		} else {
			record('console.' + p.type, text);
		}
	});
	cdp.on('Runtime.exceptionThrown', (p, sid) => {
		if (sid !== sessionId) return;
		counters.exceptions++;
		const d = p.exceptionDetails || {};
		record('exception', d.text + ' ' + ((d.exception && d.exception.description) || ''));
	});
	cdp.on('Log.entryAdded', (p, sid) => {
		if (sid !== sessionId) return;
		const e = p.entry || {};
		if (e.level === 'error') {
			counters.logErrors++;
			record('log.error', `[${e.source}] ${e.text} ${e.url || ''}`);
		} else if (e.level === 'warning') {
			counters.logWarnings++;
			record('log.warning', `[${e.source}] ${e.text} ${e.url || ''}`);
		}
	});

	await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT }, sessionId);

	/* ---- go ---------------------------------------------------------------- */
	await cdp.send('Page.navigate', { url: URL_ }, sessionId);
	await new Promise((resolve) => {
		const h = (p, sid) => {
			if (sid === sessionId) resolve();
		};
		cdp.on('Page.loadEventFired', h);
		setTimeout(resolve, 30000);
	});

	// Wait for both panels to have mounted before anchoring the clock.
	let ready = null;
	for (let i = 0; i < 240; i++) {
		ready = await evaluate(
			cdp,
			sessionId,
			`(() => { const p = window.BonsaiPlate && window.BonsaiPlate.panel ? window.BonsaiPlate.panel.stats() : null;
			   return { duet: !!window.BonsaiDuet, term: !!(window.BonsaiTerminal && window.BonsaiTerminal.renderer),
			     plate: !!p, seated: !!p && p.lo >= 0 && p.baseIndex !== null }; })()`,
		);
		if (ready.duet && ready.term && ready.plate && ready.seated) break;
		await sleep(250);
	}
	if (!ready || !ready.duet || !ready.term || !ready.plate || !ready.seated) {
		throw new Error(`panels never mounted: ${JSON.stringify(ready)}`);
	}

	const anchorSent = Date.now();
	const anchorProbe = await evaluate(cdp, sessionId, PROBE);
	const anchorWall = Math.round((anchorSent + Date.now()) / 2);
	const anchorRealElapsed = anchorProbe.realElapsed; // real seconds the clock had already run
	log('');
	log(`Panels mounted. ASCII steps=${anchorProbe.stepCount}  ladder frames=${anchorProbe.frameCount}`);
	log(`Anchor         wall=${iso(anchorWall)}  clock realElapsed=${f(anchorRealElapsed, 4)}s  t=${f(anchorProbe.t, 9)}`);
	log(
		`Elapsed below is the RUNNER's own wall clock (anchor + Date.now()), not the page's.`,
	);
	log('');
	log(
		[
			'#'.padStart(3),
			'wall-clock'.padEnd(21),
			'elapsed'.padStart(8),
			't'.padStart(10),
			'DRIFT'.padStart(11),
			'step'.padStart(9),
			'frames lo/hi'.padStart(13),
			'frac'.padStart(6),
			'heapMB'.padStart(7),
			'cdpMB'.padStart(7),
			'cache'.padStart(6),
			'err'.padStart(4),
			'LT'.padStart(4),
		].join(' '),
	);
	log('-'.repeat(128));

	/* ---- event schedule ---------------------------------------------------- */
	const events = [];
	for (let s = 0; s <= CFG.soakSeconds; s += CFG.sampleEvery) events.push({ at: s, kind: 'sample' });
	for (const s of CFG.shotAt) events.push({ at: s, kind: 'shot' });
	events.push({ at: CFG.hideAt, kind: 'hide' });
	const order = { shot: 0, sample: 1, hide: 2 };
	events.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);

	const samples = [];
	let lastCounters = { ...counters };
	let lastLongTasks = 0;
	let sampleNo = 0;
	const shots = [];
	let n8 = null;

	const elapsedNow = () => (Date.now() - anchorWall) / 1000 + anchorRealElapsed;

	async function takeSample(label) {
		// Midpoint of the CDP round trip is the runner's best estimate of the
		// instant the probe actually ran inside the page. Using the time the
		// reply arrived would charge the page for the runner's own latency.
		const sent = Date.now();
		const p = await evaluate(cdp, sessionId, PROBE);
		const wall = Math.round((sent + Date.now()) / 2);
		const rtt = Date.now() - sent;
		const elapsed = (wall - anchorWall) / 1000 + anchorRealElapsed;
		// With a speed multiplier the model advances faster; expected t scales.
		const expT = Math.min(1, (elapsed * CFG.speed) / CFG.pageDuration);
		const drift = Math.abs(p.t - expT);
		const driftRendered = Math.abs((p.tRendered ?? p.t) - expT);
		const heap = await cdp.send('Runtime.getHeapUsage', {}, sessionId).catch(() => null);
		const errDelta =
			counters.consoleErrors - lastCounters.consoleErrors +
			(counters.exceptions - lastCounters.exceptions) +
			(counters.logErrors - lastCounters.logErrors);
		const ltDelta = p.longTasks - lastLongTasks;
		const row = {
			n: ++sampleNo,
			label: label || '',
			wall,
			wallIso: iso(wall),
			probeRttMs: rtt,
			elapsed: +elapsed.toFixed(3),
			expectedT: +expT.toFixed(9),
			t: p.t,
			tRendered: p.tRendered,
			drift: +drift.toFixed(9),
			driftMs: +(drift * CFG.pageDuration * 1000).toFixed(1),
			driftRendered: +driftRendered.toFixed(9),
			driftRenderedMs: +(driftRendered * CFG.pageDuration * 1000).toFixed(1),
			visibility: p.visibility,
			phase: p.phase,
			step: p.step,
			stepCount: p.stepCount,
			lo: p.lo,
			hi: p.hi,
			frac: p.frac === null ? null : +p.frac.toFixed(4),
			baseIndex: p.baseIndex,
			topIndex: p.topIndex,
			plateState: p.plateState,
			bodyState: p.bodyState,
			fillWidth: p.fillWidth,
			done: p.done,
			clockDone: p.clockDone,
			heapUsed: p.heapUsed,
			heapTotal: p.heapTotal,
			cdpHeapUsed: heap ? heap.usedSize : null,
			cdpHeapTotal: heap ? heap.totalSize : null,
			cacheHeld: p.cacheHeld,
			cacheBytes: p.cacheBytes,
			cacheFetched: p.cacheFetched,
			cacheEvicted: p.cacheEvicted,
			cacheFailed: p.cacheFailed,
			domNodes: p.domNodes,
			errorsSinceLast: errDelta,
			warningsSinceLast:
				counters.consoleWarnings - lastCounters.consoleWarnings +
				(counters.logWarnings - lastCounters.logWarnings),
			errorsTotal: counters.consoleErrors + counters.exceptions + counters.logErrors,
			longTasksSinceLast: ltDelta,
			longTasksTotal: p.longTasks,
			longTaskMsTotal: p.longTaskMs,
			longTaskMax: p.longTaskMax,
			rafCalls: p.rafCalls,
			rafFires: p.rafFires,
			maxRafGap: p.maxRafGap,
		};
		lastCounters = { ...counters };
		lastLongTasks = p.longTasks;
		samples.push(row);
		jlog(row);
		log(
			[
				String(row.n).padStart(3),
				row.wallIso.padEnd(21),
				(f(row.elapsed, 1) + 's').padStart(8),
				f(row.t, 7).padStart(10),
				f(row.drift, 8).padStart(11),
				`${row.step}/${row.stepCount}`.padStart(9),
				`${row.lo}/${row.hi}`.padStart(13),
				f(row.frac, 3).padStart(6),
				mb(row.heapUsed).padStart(7),
				mb(row.cdpHeapUsed).padStart(7),
				String(row.cacheHeld).padStart(6),
				String(row.errorsSinceLast).padStart(4),
				String(row.longTasksSinceLast).padStart(4),
			].join(' ') + (label ? `   <<< ${label}` : ''),
		);
		return row;
	}

	async function screenshot(name) {
		const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
		const cs = metrics.cssContentSize || metrics.contentSize;
		const data = await cdp.send(
			'Page.captureScreenshot',
			{
				format: 'png',
				captureBeyondViewport: true,
				clip: { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.ceil(cs.height), scale: 1 },
			},
			sessionId,
		);
		const file = path.join(CFG.shotDir, name);
		writeFileSync(file, Buffer.from(data.data, 'base64'));
		const p = await evaluate(cdp, sessionId, PROBE);
		shots.push({ file, t: p.t, wall: Date.now(), w: Math.ceil(cs.width), h: Math.ceil(cs.height) });
		log(`      >>> screenshot ${name}  (${Math.ceil(cs.width)}x${Math.ceil(cs.height)}, t=${f(p.t, 6)})`);
		return p;
	}

	/* ---- N8: hide the tab for real ---------------------------------------- */
	async function hideAndRestore() {
		log('');
		log('-'.repeat(120));
		log(`N8 BACKGROUNDING TEST — hiding the tab for ${CFG.hideFor}s`);
		const before = await evaluate(cdp, sessionId, PROBE);
		await evaluate(cdp, sessionId, `(() => { const s=window.__soak; s.maxGap=0; s.lastFire=-1; return true; })()`);
		const hideWall = Date.now();

		// A real hide: open a second tab in the same window and activate it.
		const other = await cdp.send('Target.createTarget', { url: 'about:blank' });
		await cdp.send('Target.activateTarget', { targetId: other.targetId });
		await sleep(1200);
		const hiddenCheck = await evaluate(cdp, sessionId, `document.visibilityState`);
		log(`  visibilityState after activating the other tab: "${hiddenCheck}"`);
		if (hiddenCheck !== 'hidden') {
			log('  !! the page did NOT go hidden — see the verdict; this is reported, not hidden.');
		}

		const midway = await evaluate(cdp, sessionId, PROBE);
		await sleep(Math.max(0, CFG.hideFor * 1000 - (Date.now() - hideWall)));

		const beforeShow = await evaluate(cdp, sessionId, PROBE);
		// Arm the recorder while still hidden: its first sample IS the first frame back.
		await evaluate(cdp, sessionId, `window.__armRecovery(4000)`);
		const restoreWall = Date.now();
		await cdp.send('Target.activateTarget', { targetId });
		await sleep(4500);
		const after = await evaluate(cdp, sessionId, PROBE);
		const rec = await evaluate(
			cdp,
			sessionId,
			`(() => { const r = window.__soak.rec; return { done: r.done, n: r.samples.length, samples: r.samples, vis: window.__soak.visLog, maxGap: window.__soak.maxGap }; })()`,
		);
		await cdp.send('Target.closeTarget', { targetId: other.targetId }).catch(() => {});

		const hiddenMs = restoreWall - hideWall;
		const visEvents = rec.vis || [];
		const showEvent = [...visEvents].reverse().find((v) => v.state === 'visible');
		const hideEvent = [...visEvents].reverse().find((v) => v.state === 'hidden');
		const s0 = rec.samples[0] || null;
		// Recovery = first recorded frame at which the plate is not recovering,
		// not fading, and the painted base is the frame the playhead wants.
		let recoveredAt = null;
		for (const s of rec.samples) {
			if (!s.recovering && s.state !== 'resyncing' && s.base !== null && Math.abs(s.base - s.lo) <= 1 && s.painted) {
				recoveredAt = s;
				break;
			}
		}
		const anyBlank = rec.samples.filter((s) => !s.painted);
		const baseSeq = [];
		for (const s of rec.samples) if (!baseSeq.length || baseSeq[baseSeq.length - 1] !== s.base) baseSeq.push(s.base);
		const states = [];
		for (const s of rec.samples) if (!states.length || states[states.length - 1] !== s.state) states.push(s.state);

		n8 = {
			hideWall,
			restoreWall,
			hiddenMs,
			visibilityWhileHidden: hiddenCheck,
			tBeforeHide: before.t,
			tBeforeShow: beforeShow.t,
			tAfterRestore: after.t,
			modelSecondsMissed: (beforeShow.t - before.t) * CFG.pageDuration,
			stepBefore: before.step,
			stepAfterFirstFrame: s0 ? s0.step : null,
			stepAfter: after.step,
			frameBefore: before.lo,
			frameAfter: after.lo,
			maxRafGapMs: rec.maxGap,
			firstFrameDtMs: s0 ? s0.dt : null,
			recoveryMs: recoveredAt ? recoveredAt.dt : null,
			recoveredBase: recoveredAt ? recoveredAt.base : null,
			blankFrames: anyBlank.length,
			framesRecorded: rec.samples.length,
			baseSequence: baseSeq,
			plateStateSequence: states,
			visibilityEvents: visEvents,
			hideEventWall: hideEvent ? hideEvent.wall : null,
			showEventWall: showEvent ? showEvent.wall : null,
			expectedStepAfterRestore: null,
			recoverySamples: rec.samples.slice(0, 40),
		};
		n8.expectedStepAfterRestore = Math.floor(beforeShow.t * before.stepCount);

		log(`  t before hide ......... ${f(before.t, 7)}   step ${before.step}/${before.stepCount}   frames ${before.lo}/${before.hi}`);
		log(`  t just before restore . ${f(beforeShow.t, 7)}   (hidden for ${(hiddenMs / 1000).toFixed(1)}s real)`);
		log(`  t after restore ....... ${f(after.t, 7)}   step ${after.step}/${after.stepCount}   frames ${after.lo}/${after.hi}`);
		log(`  model time missed ..... ${f(n8.modelSecondsMissed, 1)}s of growth`);
		log(`  max rAF gap ........... ${f(rec.maxGap, 0)} ms  (proves rAF really was suspended)`);
		log(`  first frame back at ... +${f(n8.firstFrameDtMs, 1)} ms; step on that frame = ${n8.stepAfterFirstFrame} (wanted ${n8.expectedStepAfterRestore})`);
		log(`  recovery complete at .. ${n8.recoveryMs === null ? 'NOT REACHED in 4s' : '+' + f(n8.recoveryMs, 0) + ' ms'}`);
		log(`  blank frames .......... ${n8.blankFrames} of ${n8.framesRecorded} recorded animation frames`);
		log(`  base frame sequence ... ${baseSeq.slice(0, 12).join(' -> ')}${baseSeq.length > 12 ? ' ...' : ''}`);
		log(`  plate state sequence .. ${states.join(' -> ')}`);
		log('-'.repeat(120));
		log('');
	}

	/* ---- run the schedule -------------------------------------------------- */
	for (const ev of events) {
		const targetWall = anchorWall + (ev.at - anchorRealElapsed) * 1000;
		const wait = targetWall - Date.now();
		if (wait > 0) await sleep(wait);
		if (ev.kind === 'sample') await takeSample();
		else if (ev.kind === 'shot') {
			const p = await evaluate(cdp, sessionId, PROBE);
			await screenshot(`${CFG.shotPrefix}-t${p.t.toFixed(2)}.png`);
		} else if (ev.kind === 'hide') await hideAndRestore();
	}

	/* ---- the end: bloom, stop, and stay stopped ---------------------------- */
	log('');
	log('='.repeat(120));
	log('FINALE CHECKS');
	// Wait until the clock reports done (it should already, at t=1).
	for (let i = 0; i < 120; i++) {
		const p = await evaluate(cdp, sessionId, PROBE);
		if (p.done && p.bodyState === 'held') break;
		await sleep(500);
	}
	const endShot = await screenshot(`${CFG.shotPrefix}-t1.00.png`);
	const atEnd = await takeSample('t=1 reached');

	const rafBefore = atEnd.rafCalls;
	const quietSeconds = PREFLIGHT ? 10 : 30;
	log(`  holding for ${quietSeconds}s to see whether anything is still scheduling work...`);
	await sleep(quietSeconds * 1000);
	const after = await takeSample(`+${quietSeconds}s after t=1`);
	const rafDelta = after.rafCalls - rafBefore;

	const stillTrue = {
		clockDone: after.clockDone,
		frameDone: after.done,
		t: after.t,
		bodyState: after.bodyState,
		bodySettled: after.bodySettled,
		fillWidth: after.fillWidth,
		step: `${after.step}/${after.stepCount}`,
		plateFrames: `${after.lo}/${after.hi}`,
		baseIndex: after.baseIndex,
		plateState: after.plateState,
		rafScheduledAfterDone: rafDelta,
		cacheHeld: after.cacheHeld,
		cacheBytes: after.cacheBytes,
	};
	for (const [k, v] of Object.entries(stillTrue)) log(`  ${k.padEnd(24)} ${v}`);

	/* ---- summary numbers --------------------------------------------------- */
	const heaps = samples.map((s) => s.heapUsed).filter((v) => typeof v === 'number');
	const sorted = [...heaps].sort((a, b) => a - b);
	const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
	const cdpHeaps = samples.map((s) => s.cdpHeapUsed).filter((v) => typeof v === 'number');
	const cdpSorted = [...cdpHeaps].sort((a, b) => a - b);
	const drifts = samples.map((s) => s.drift);
	const driftsRendered = samples.map((s) => s.driftRendered);
	const oneRafFrameT = 16.7 / (CFG.pageDuration * 1000);
	const oneLadderFrameT = 1 / ((atEnd.hi ?? 599) || 599);

	const summary = {
		config: CFG,
		url: URL_,
		headless: HEADLESS,
		chrome: version.Browser,
		anchorWall,
		anchorIso: iso(anchorWall),
		endIso: iso(),
		sampleCount: samples.length,
		drift: {
			max: Math.max(...drifts),
			maxMs: Math.max(...drifts) * CFG.pageDuration * 1000,
			mean: drifts.reduce((a, b) => a + b, 0) / drifts.length,
			final: drifts[drifts.length - 1],
			maxRendered: Math.max(...driftsRendered),
			maxRenderedMs: Math.max(...driftsRendered) * CFG.pageDuration * 1000,
			oneRafFrameT,
			oneLadderFrameT,
			everExceededOneRafFrame: Math.max(...drifts) > oneRafFrameT,
			everExceededOneLadderFrame: Math.max(...drifts) > oneLadderFrameT,
		},
		heap: {
			firstBytes: heaps[0] ?? null,
			medianBytes: median,
			peakBytes: heaps.length ? Math.max(...heaps) : null,
			finalBytes: heaps.length ? heaps[heaps.length - 1] : null,
			deltaBytes: heaps.length ? heaps[heaps.length - 1] - heaps[0] : null,
			cdpFirstBytes: cdpHeaps[0] ?? null,
			cdpMedianBytes: cdpSorted.length ? cdpSorted[Math.floor(cdpSorted.length / 2)] : null,
			cdpPeakBytes: cdpHeaps.length ? Math.max(...cdpHeaps) : null,
			cdpFinalBytes: cdpHeaps.length ? cdpHeaps[cdpHeaps.length - 1] : null,
		},
		cache: {
			first: samples[0].cacheHeld,
			peak: Math.max(...samples.map((s) => s.cacheHeld ?? 0)),
			final: after.cacheHeld,
			finalBytes: after.cacheBytes,
			fetchedTotal: after.cacheFetched,
			evictedTotal: after.cacheEvicted,
			failedTotal: after.cacheFailed,
		},
		dom: { first: samples[0].domNodes, final: after.domNodes },
		errors: { ...counters, messages },
		longTasks: { total: after.longTasksTotal, totalMs: after.longTaskMsTotal, max: after.longTaskMax },
		raf: { totalCalls: after.rafCalls, totalFires: after.rafFires, scheduledAfterDone: rafDelta },
		finale: stillTrue,
		n8,
		shots,
		samples,
	};
	writeFileSync(path.join(import.meta.dirname, `${CFG.tag}-summary.json`), JSON.stringify(summary, null, 2));

	log('');
	log('HEADLINE');
	log(`  max DRIFT ............... ${f(summary.drift.max, 9)}  (${f(summary.drift.maxMs, 1)} ms of model time)`);
	log(`  one animation frame is .. ${f(oneRafFrameT, 9)} in t; one ladder frame is ${f(oneLadderFrameT, 9)}`);
	log(`  drift ever > 1 rAF frame  ${summary.drift.everExceededOneRafFrame}`);
	log(`  drift ever > 1 ladder fr. ${summary.drift.everExceededOneLadderFrame}`);
	log(`  heap first/median/peak/final  ${mb(summary.heap.firstBytes)} / ${mb(summary.heap.medianBytes)} / ${mb(summary.heap.peakBytes)} / ${mb(summary.heap.finalBytes)} MB  (performance.memory)`);
	log(`  heap first/median/peak/final  ${mb(summary.heap.cdpFirstBytes)} / ${mb(summary.heap.cdpMedianBytes)} / ${mb(summary.heap.cdpPeakBytes)} / ${mb(summary.heap.cdpFinalBytes)} MB  (CDP Runtime.getHeapUsage)`);
	log(`  frame cache first/peak/final  ${summary.cache.first} / ${summary.cache.peak} / ${summary.cache.final} entries`);
	log(`  console errors .......... ${counters.consoleErrors}  exceptions ${counters.exceptions}  browser-log errors ${counters.logErrors}`);
	log(`  warnings ................ ${counters.consoleWarnings} console, ${counters.logWarnings} browser-log`);
	log(`  long tasks .............. ${summary.longTasks.total} (${f(summary.longTasks.totalMs, 0)} ms total, max ${f(summary.longTasks.max, 0)} ms)`);
	log(`  rAF scheduled after t=1 . ${rafDelta}`);
	log(`M4 ${CFG.tag.toUpperCase()} — end ${iso()}`);
	log('='.repeat(120));

	cdp.close();
	proc.kill();
	await sleep(500);
	try {
		process.kill(proc.pid);
	} catch {
		/* already dead */
	}
}

main().catch((err) => {
	log(`FATAL: ${err && err.stack ? err.stack : err}`);
	process.exitCode = 1;
});
