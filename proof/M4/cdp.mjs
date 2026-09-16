/**
 * Minimal Chrome DevTools Protocol client.
 *
 * No npm dependencies: Node 24 ships a global WebSocket. Enough CDP to launch
 * headless Chrome, attach a flat session to a tab, evaluate JS, take
 * screenshots, and switch the active tab (which is how a real tab is hidden).
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export class CDP {
	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		this.handlers = new Map();
		this.closed = false;
		ws.addEventListener('message', (ev) => this._onMessage(String(ev.data)));
		ws.addEventListener('close', () => {
			this.closed = true;
			for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
			this.pending.clear();
		});
	}

	static async connect(wsUrl) {
		const ws = new WebSocket(wsUrl);
		await new Promise((resolve, reject) => {
			ws.addEventListener('open', resolve, { once: true });
			ws.addEventListener('error', () => reject(new Error(`cannot connect: ${wsUrl}`)), {
				once: true,
			});
		});
		return new CDP(ws);
	}

	_onMessage(text) {
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (msg.id !== undefined && this.pending.has(msg.id)) {
			const { resolve, reject } = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
			else resolve(msg.result);
			return;
		}
		if (msg.method) {
			const list = this.handlers.get(msg.method);
			if (list) for (const fn of list) fn(msg.params || {}, msg.sessionId);
		}
	}

	on(method, fn) {
		if (!this.handlers.has(method)) this.handlers.set(method, []);
		this.handlers.get(method).push(fn);
	}

	send(method, params = {}, sessionId) {
		if (this.closed) return Promise.reject(new Error('CDP socket closed'));
		const id = this.nextId++;
		const payload = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify(payload));
		});
	}

	close() {
		try {
			this.ws.close();
		} catch {
			/* already gone */
		}
	}
}

export const CHROME =
	process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export async function launchChrome({ port, userDataDir, headless = true, windowSize = '1600,1000' }) {
	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${userDataDir}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-sync',
		'--disable-extensions',
		'--no-service-autorun',
		'--password-store=basic',
		'--use-mock-keychain',
		'--hide-scrollbars',
		'--force-device-scale-factor=1',
		'--enable-precise-memory-info',
		`--window-size=${windowSize}`,
		'about:blank',
	];
	if (headless) args.unshift('--headless=new');
	const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
	proc.stdout.resume();
	proc.stderr.resume();

	let version = null;
	for (let i = 0; i < 100; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) {
				version = await res.json();
				break;
			}
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	if (!version) {
		proc.kill();
		throw new Error(`Chrome did not expose CDP on port ${port}`);
	}
	return { proc, version };
}

export async function newPage(cdp, url) {
	const { targetId } = await cdp.send('Target.createTarget', { url });
	const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
	return { targetId, sessionId };
}

export async function evaluate(cdp, sessionId, expression) {
	const r = await cdp.send(
		'Runtime.evaluate',
		{ expression, returnByValue: true, awaitPromise: true },
		sessionId,
	);
	if (r.exceptionDetails) {
		throw new Error(
			`evaluate threw: ${r.exceptionDetails.text} ${
				r.exceptionDetails.exception ? r.exceptionDetails.exception.description : ''
			}`,
		);
	}
	return r.result ? r.result.value : undefined;
}
