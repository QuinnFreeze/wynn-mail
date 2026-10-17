import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { startMailboxLiveSync } from './live';
import { MAIL_CHANGED_MESSAGE, MAILBOX_DATA_DEPENDENCY } from './sync';

type PendingRequest = {
	url: string;
	signal: AbortSignal;
	respond(cursor: string, status?: number): void;
	fail(error: Error): void;
};

/** A synthetic visible tab and abort-aware fetch; no real network or user data. */
function liveFixture() {
	const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
	const window = new EventTarget();
	const serviceWorker = new EventTarget();
	const requests: PendingRequest[] = [];
	const invalidations: string[] = [];
	let changed = 0;
	window.addEventListener(MAIL_CHANGED_MESSAGE, () => changed++);
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const fetcher = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const signal = init?.signal;
		assert.ok(signal);
		return new Promise<Response>((resolve, reject) => {
			const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
			const settle = (callback: () => void) => {
				signal.removeEventListener('abort', onAbort);
				callback();
			};
			requests.push({
				url: String(url), signal,
				respond(cursor, status = 200) {
					settle(() => resolve(new Response(JSON.stringify({ cursor }), { status })));
				},
				fail(error) { settle(() => reject(error)); }
			});
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		});
	};
	for (const [key, value] of Object.entries({ document, window, navigator: { serviceWorker }, fetch: fetcher })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, value });
	}
	const stop = startMailboxLiveSync(async (dependency) => { invalidations.push(dependency); });
	return {
		document, window, serviceWorker, requests, invalidations,
		get changed() { return changed; },
		push() {
			serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: MAIL_CHANGED_MESSAGE } }));
		},
		async cleanup() {
			stop();
			await nextTurn();
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	};
}

test('live mail refresh invalidates only its explicit dependency after a changed cursor', async () => {
	const f = liveFixture();
	try {
		f.requests[0].respond('1:0');
		await nextTurn();
		assert.deepEqual(f.invalidations, []);
		assert.equal(f.requests[1].url, '/api/mail/sync?cursor=1%3A0');
		f.requests[1].respond('2:0');
		await nextTurn();
		assert.deepEqual(f.invalidations, [MAILBOX_DATA_DEPENDENCY]);
		assert.equal(f.changed, 1);
		assert.equal(f.requests.length, 3);
	} finally { await f.cleanup(); }
});

test('push aborts the held poll and immediately checks again without refreshing unchanged data', async () => {
	const f = liveFixture();
	try {
		f.requests[0].respond('1:0');
		await nextTurn();
		f.push();
		await nextTurn();
		assert.equal(f.requests[1].signal.aborted, true);
		assert.equal(f.requests.length, 3);
		assert.equal(f.requests[2].url, '/api/mail/sync?cursor=1%3A0');
		f.requests[2].respond('1:0');
		await nextTurn();
		assert.deepEqual(f.invalidations, []);
	} finally { await f.cleanup(); }
});

test('a push before the first cursor is remembered and refreshes the bootstrap snapshot once', async () => {
	const f = liveFixture();
	try {
		f.push();
		await nextTurn();
		assert.equal(f.requests[0].signal.aborted, true);
		assert.equal(f.requests.length, 2);
		f.requests[1].respond('2:0');
		await nextTurn();
		assert.deepEqual(f.invalidations, [MAILBOX_DATA_DEPENDENCY]);
		assert.equal(f.changed, 1);
		f.requests[2].respond('2:0');
		await nextTurn();
		assert.deepEqual(f.invalidations, [MAILBOX_DATA_DEPENDENCY]);
	} finally { await f.cleanup(); }
});

test('push also interrupts network-error retry backoff', async () => {
	const f = liveFixture();
	try {
		f.requests[0].fail(new TypeError('Synthetic offline state'));
		await nextTurn();
		assert.equal(f.requests.length, 1);
		f.push();
		await nextTurn();
		assert.equal(f.requests.length, 2);
		assert.deepEqual(f.invalidations, []);
	} finally { await f.cleanup(); }
});

test('hidden tabs pause, visibility resumes, and cleanup aborts the active request', async () => {
	const f = liveFixture();
	try {
		f.document.visibilityState = 'hidden';
		f.document.dispatchEvent(new Event('visibilitychange'));
		await nextTurn();
		assert.equal(f.requests[0].signal.aborted, true);
		f.push();
		await nextTurn();
		assert.equal(f.requests.length, 1);
		f.document.visibilityState = 'visible';
		f.document.dispatchEvent(new Event('visibilitychange'));
		await nextTurn();
		assert.equal(f.requests.length, 2);
	} finally { await f.cleanup(); }
	assert.equal(f.requests.at(-1)?.signal.aborted, true);
	f.push();
	f.window.dispatchEvent(new Event('online'));
	await nextTurn();
	assert.equal(f.requests.length, 2);
});

test('lost authorization stops polling until the signed-in shell is replaced', async () => {
	const f = liveFixture();
	try {
		f.requests[0].respond('', 401);
		await nextTurn();
		f.push();
		f.window.dispatchEvent(new Event('online'));
		await nextTurn();
		assert.equal(f.requests.length, 1);
		assert.deepEqual(f.invalidations, []);
	} finally { await f.cleanup(); }
});
