import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import type { Handle, RequestHandler } from '@sveltejs/kit';
import { handle } from '../../hooks.server';
import { load as shell } from '../../routes/+layout.server';
import { load as inbox } from '../../routes/inbox/+page.server';
import { load as settings } from '../../routes/settings/+layout.server';
import { GET as retention } from '../../routes/api/settings/mail-retention/+server';
import { GET as sync } from '../../routes/api/mail/sync/+server';
import { GET as listMail } from '../../routes/api/mail/+server';
import { POST as selectDomain } from '../../routes/api/domains/select/+server';
import { POST as mailActions } from '../../routes/api/mail/actions/+server';
import { GET as adminUsers } from '../../routes/api/admin/users/+server';
import { createBrowserSession } from './auth';
import { createTestDb, insertTestUser } from './test-db';

type HookEvent = Parameters<Handle>[0]['event'];

/** Real SQLite-backed statements with a shared 5 ms delay per independent
 * query wave. This measures dependencies without flaky wall-clock assertions. */
function instrument(db: D1Database) {
	const statements: string[] = [];
	let waves = 0;
	let pending: Array<() => void> = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const delay = () => new Promise<void>((resolve) => {
		pending.push(resolve);
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			waves += 1;
			const ready = pending;
			pending = [];
			ready.forEach((resolve) => resolve());
		}, 5);
	});
	const counted = new Proxy(db, { get(target, property) {
		if (property !== 'prepare') {
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
		return (sql: string) => {
			const statement = target.prepare(sql);
			let wrapped: typeof statement;
			wrapped = new Proxy(statement, { get(source, key) {
				if (key === 'bind') return (...bindings: unknown[]) => { source.bind(...bindings); return wrapped; };
				if (key === 'first' || key === 'all' || key === 'run') return async (...args: unknown[]) => {
					statements.push(sql.replace(/\s+/g, ' ').trim());
					await delay();
					return Reflect.apply(Reflect.get(source, key, source), source, args);
				};
				const value = Reflect.get(source, key, source);
				return typeof value === 'function' ? value.bind(source) : value;
			} });
			return wrapped;
		};
	} });
	return { db: counted, statements, networkMs: () => waves * 5, reset: () => { statements.length = 0; waves = 0; } };
}

async function fixture() {
	const f = createTestDb();
	insertTestUser(f.sqlite, 'member');
	insertTestUser(f.sqlite, 'other');
	f.sqlite.exec(`INSERT INTO domains(id,name,status,sending_enabled,receiving_enabled) VALUES
		('one.test','one.test','verified',1,1),('two.test','two.test','verified',1,1);
		INSERT INTO addresses(id,user_id,domain_id,address,is_default) VALUES
		('member-address','member','one.test','member@one.test',1),('other-address','other','one.test','other@one.test',1);
		INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,domain_id) VALUES
		('own-one','member','inbound','a@example.test','member@one.test','Synthetic one','one.test'),
		('own-two','member','inbound','a@example.test','member@one.test','Synthetic two','two.test'),
		('foreign','other','inbound','a@example.test','other@one.test','Synthetic foreign','one.test');`);
	const session = await createBrowserSession(f.db, 'member');
	return { ...f, session, trace: instrument(f.db) };
}

function event(f: Awaited<ReturnType<typeof fixture>>, path: string, options: {
	method?: string; body?: unknown; cookies?: Map<string, string>;
} = {}): HookEvent {
	const url = new URL(path, 'https://mail.example.test');
	const cookies = options.cookies ?? new Map([['mail_session', f.session.token]]);
	return {
		url, request: new Request(url, {
			method: options.method ?? 'GET',
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body), headers: { 'content-type': 'application/json', origin: url.origin } })
		}), locals: {}, platform: { env: { DB: f.trace.db } }, route: { id: url.pathname },
		params: { section: url.pathname.startsWith('/settings/') ? url.pathname.split('/').at(-1) : undefined },
		cookies: { get: (key: string) => cookies.get(key), set: (key: string, value: string) => cookies.set(key, value),
			delete: (key: string) => cookies.delete(key) }
	} as unknown as HookEvent;
}

async function request(f: Awaited<ReturnType<typeof fixture>>, path: string, handler: RequestHandler, options: Parameters<typeof event>[2] = {}) {
	const input = event(f, path, options);
	const response = await handle({ event: input, resolve: (e) => Promise.resolve(handler(e)) });
	return { response, locals: input.locals };
}

async function page(f: Awaited<ReturnType<typeof fixture>>, path: string) {
	const input = event(f, path);
	const dependencies: string[] = [];
	const response = await handle({ event: input, resolve: async (e) => {
		const loadEvent = { ...e, depends: (...names: string[]) => dependencies.push(...names) };
		const [layout, data] = await Promise.all([
			shell(loadEvent as unknown as Parameters<typeof shell>[0]),
			path.startsWith('/settings')
				? settings(loadEvent as unknown as Parameters<typeof settings>[0])
				: inbox(loadEvent as unknown as Parameters<typeof inbox>[0])
		]);
		return Response.json({ layout, data });
	} });
	return { response, dependencies, locals: input.locals };
}

describe('request query budgets with real hooks, loads and SQLite', () => {
	test('only authenticated HTML receives a private no-store policy without extra database work', async () => {
		const f = await fixture();
		const cases = [
			{ name: 'authenticated HTML', path: '/inbox', signedIn: true, type: 'text/html; charset=utf-8', original: null, expected: 'private, no-store', queries: 3 },
			{ name: 'authenticated HTML overrides public policy', path: '/inbox', signedIn: true, type: 'text/html', original: 'public, max-age=300', expected: 'private, no-store', queries: 3 },
			{ name: 'anonymous HTML', path: '/login', signedIn: false, type: 'text/html', original: null, expected: null, queries: 1 },
			{ name: 'anonymous HTML retains policy', path: '/login', signedIn: false, type: 'text/html', original: 'no-cache', expected: 'no-cache', queries: 1 },
			{ name: 'authenticated data', path: '/inbox/__data.json', signedIn: true, type: 'application/json', original: 'no-store', expected: 'no-store', queries: 3 },
			{ name: 'API keeps route policy', path: '/api/settings/mail-retention', signedIn: true, type: 'application/json', original: 'no-store', expected: 'no-store', queries: 1 },
			{ name: 'HTML API keeps route policy', path: '/api/settings/mail-retention', signedIn: true, type: 'text/html', original: 'no-cache', expected: 'no-cache', queries: 1 }
		];
		for (const entry of cases) {
			f.trace.reset();
			const input = event(f, entry.path, entry.signedIn ? {} : { cookies: new Map() });
			const headers = new Headers({ 'Content-Type': entry.type, 'X-Synthetic-Header': 'preserved' });
			if (entry.original) headers.set('Cache-Control', entry.original);
			const response = await handle({ event: input, resolve: () => Promise.resolve(new Response('synthetic body', { status: 200, headers })) });
			assert.equal(response.headers.get('cache-control'), entry.expected, entry.name);
			assert.equal(response.headers.get('x-synthetic-header'), 'preserved', entry.name);
			assert.equal(response.status, 200);
			assert.equal(await response.text(), 'synthetic body');
			assert.equal(f.trace.statements.length, entry.queries, entry.name);
		}
	});

	test('non-empty inbox keeps the original mailbox while reducing baseline 13 queries / 40 ms to 10 / 30 ms', async () => {
		const f = await fixture();
		const result = await page(f, '/inbox?category=all');
		const body = await result.response.json();
		assert.equal(body.data.mailbox.total, 2);
		assert.equal(f.trace.statements.length, 10);
		assert.equal(f.trace.networkMs(), 30);
		assert.ok(result.dependencies.includes('app:mail'));
		assert.equal(f.trace.statements.some((sql) => sql === 'SELECT COUNT(*) AS count FROM users'), false);
		assert.equal(f.trace.statements.some((sql) => /^SELECT (ui_theme|locale) FROM users/.test(sql)), false);
	});

	test('settings load only the current section; classic keeps the full payload', async () => {
		const cases = [
			{ theme: 'zero', section: 'general', queries: 7, signature: true, connections: false },
			{ theme: 'zero', section: 'appearance', queries: 6, signature: false, connections: false },
			{ theme: 'zero', section: 'connections', queries: 9, signature: false, connections: true },
			{ theme: 'classic', section: '', queries: 10, signature: true, connections: true }
		];
		for (const entry of cases) {
			const f = await fixture();
			f.sqlite.query("UPDATE users SET ui_theme = ?, email_signature = 'Synthetic signature' WHERE id = 'member'").run(entry.theme);
			const result = await page(f, `/settings${entry.section ? `/${entry.section}` : ''}`);
			const { data } = await result.response.json();
			assert.equal(f.trace.statements.length, entry.queries, `${entry.theme}/${entry.section}`);
			assert.equal(f.trace.networkMs(), 15);
			assert.equal(data.signature, entry.signature ? 'Synthetic signature' : '');
			assert.equal(data.devices.length, entry.connections ? 1 : 0);
			assert.equal(f.trace.statements.some((sql) => /FROM api_tokens WHERE user_id/.test(sql)), entry.connections);
			assert.equal(f.trace.statements.some((sql) => /FROM oauth_grants g LEFT JOIN/.test(sql)), entry.connections);
		}
	});

	test('cursor and account-only APIs skip shell inventories and session writes', async () => {
		const f = await fixture();
		for (const [path, handler] of [['/api/mail/sync', sync], ['/api/settings/mail-retention', retention]] as const) {
			f.trace.reset();
			const result = await request(f, path, handler);
			assert.equal(result.response.status, 200);
			assert.equal(f.trace.statements.length, 2);
			assert.equal(f.trace.networkMs(), 10);
			assert.equal(f.trace.statements.some((sql) => /^(UPDATE|INSERT|DELETE)\b/.test(sql)), false);
			assert.deepEqual(result.locals.domains, []);
			assert.deepEqual(result.locals.addresses, []);
		}
	});

	test('domain-filtered mail APIs and selection preserve connected-domain and owner checks', async () => {
		const f = await fixture();
		const selected = await request(f, '/api/mail?domain=one.test&category=all', listMail);
		assert.equal((await selected.response.json()).total, 1);
		assert.equal(selected.locals.activeDomainId, 'one.test');
		assert.deepEqual(selected.locals.addresses, []);
		const unconnected = await request(f, '/api/domains/select', selectDomain, { method: 'POST', body: { domainId: 'unknown.test' } });
		assert.equal(unconnected.response.status, 400);
		const connected = await request(f, '/api/domains/select', selectDomain, { method: 'POST', body: { domainId: 'two.test' } });
		assert.equal(connected.response.status, 200);
		const action = await request(f, '/api/mail/actions?domain=one.test', mailActions,
			{ method: 'POST', body: { action: 'read-all' } });
		assert.equal(action.response.status, 200);
		assert.deepEqual(f.sqlite.query('SELECT id,is_read FROM emails ORDER BY id').all(), [
			{ id: 'foreign', is_read: 0 }, { id: 'own-one', is_read: 1 }, { id: 'own-two', is_read: 0 }
		]);
	});

	test('role changes, first-login gates and revocation remain authoritative on every request', async () => {
		const f = await fixture();
		f.sqlite.query("UPDATE users SET is_admin = 1 WHERE id = 'member'").run();
		assert.equal((await request(f, '/api/admin/users', adminUsers)).response.status, 200);
		f.sqlite.query("UPDATE users SET is_admin = 0 WHERE id = 'member'").run();
		assert.equal((await request(f, '/api/admin/users', adminUsers)).response.status, 403);
		f.sqlite.query("UPDATE users SET must_change_password = 1 WHERE id = 'member'").run();
		assert.equal((await request(f, '/api/settings/mail-retention', retention)).response.status, 403);
		f.sqlite.query("DELETE FROM sessions WHERE user_id = 'member'").run();
		assert.equal((await request(f, '/api/settings/mail-retention', retention)).response.status, 401);
	});

	test('preferences use the current session owner and stay outside public User data', async () => {
		const f = await fixture();
		f.sqlite.query("UPDATE users SET locale = 'zh-CN', ui_theme = 'classic' WHERE id = 'member'").run();
		let result = await page(f, '/inbox');
		assert.equal(result.locals.uiTheme, 'classic');
		assert.equal(result.locals.locale, 'zh-CN');
		assert.equal(Object.hasOwn(result.locals.user!, 'ui_theme'), false);
		assert.equal(Object.hasOwn(result.locals.user!, 'preferences'), false);
		f.sqlite.query("UPDATE users SET locale = 'es', ui_theme = 'zero' WHERE id = 'member'").run();
		result = await page(f, '/inbox');
		assert.equal(result.locals.uiTheme, 'zero');
		assert.equal(result.locals.locale, 'es');
	});

	test('an expired active credential promotes only a live parked browser session with that account preferences', async () => {
		const f = await fixture();
		f.sqlite.query("UPDATE users SET locale = 'fr', ui_theme = 'classic' WHERE id = 'other'").run();
		const parked = await createBrowserSession(f.db, 'other');
		f.sqlite.query("UPDATE sessions SET expires_at = '2000-01-01' WHERE user_id = 'member'").run();
		const cookies = new Map([['mail_session', f.session.token], ['mail_accounts', JSON.stringify([parked.token])]]);
		const input = event(f, '/inbox', { cookies });
		await handle({ event: input, resolve: () => Promise.resolve(new Response('synthetic')) });
		assert.equal(input.locals.user?.id, 'other');
		assert.equal(input.locals.uiTheme, 'classic');
		assert.equal(input.locals.locale, 'fr');
		assert.equal(input.locals.addresses[0]?.user_id, 'other');
		assert.equal(cookies.get('mail_session'), parked.token);
		assert.equal(f.trace.statements.length, 4);
	});
});
