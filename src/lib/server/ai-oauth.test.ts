import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
// @ts-expect-error bun:sqlite is supplied by the test runtime.
import { Database } from 'bun:sqlite';
import {
	AI_OAUTH_COOKIE,
	AI_OAUTH_COOKIE_PATH,
	AI_OAUTH_CALLBACK_PATH,
	AI_OAUTH_TTL_SECONDS,
	AiOAuthError,
	beginOpenRouterOAuth,
	cancelOpenRouterOAuth,
	completeOpenRouterOAuth,
	openRouterOAuthAvailable
} from './ai-oauth';
import { deleteAiProvider, getAiProvider, resolveAiProvider, saveAiProvider, saveOpenRouterOAuthProvider } from './ai-provider';
import { createTestDb, insertTestUser } from './test-db';
import { POST as startRoute } from '../../routes/api/settings/ai/oauth/openrouter/start/+server';
import { GET as callbackRoute } from '../../routes/api/settings/ai/oauth/openrouter/callback/+server';

const env = { APP_URL: 'https://mail.example.com', ENCRYPTION_KEY: 'e'.repeat(40) };
const identity = { userId: 'user-1', sessionId: 'session-1' };
const key = 'sk-or-v1-private-oauth-key';

function setup() {
	const { db, sqlite } = createTestDb();
	insertTestUser(sqlite, 'user-1');
	insertTestUser(sqlite, 'user-2');
	for (const [sessionId, userId] of [['session-1', 'user-1'], ['session-2', 'user-2'], ['other-session', 'user-1']]) {
		sqlite.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
			.run(sessionId, userId, `hash-${sessionId}`, new Date(Date.now() + 86_400_000).toISOString());
	}
	return { db, sqlite };
}

function callback(started: { url: string; browserSecret: string }) {
	const url = new URL(started.url);
	return {
		state: url.searchParams.get('state'), code: 'test-authorization-code',
		browserSecret: started.browserSecret, requestOrigin: env.APP_URL
	};
}

function successfulFetch(check?: (url: string, init: RequestInit) => void): typeof fetch {
	return (async (url: string, init: RequestInit) => {
		check?.(url, init);
		return Response.json({ key });
	}) as unknown as typeof fetch;
}

const hasCode = (code: string) => (error: unknown) => error instanceof AiOAuthError && error.code === code;

function delayedExchange() {
	let signalStarted!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => { signalStarted = resolve; });
	const waiting = new Promise<void>((resolve) => { release = resolve; });
	const fetcher = (async () => {
		signalStarted();
		await waiting;
		return Response.json({ key });
	}) as typeof fetch;
	return { started, release, fetcher };
}

function routeEvent(db: ReturnType<typeof createTestDb>['db'], options: {
	authMethod?: string; requestOrigin?: string; pathname?: string; config?: typeof env;
} = {}) {
	const jar = new Map<string, string>();
	const writes: { name: string; value: string; options: Record<string, unknown> }[] = [];
	const deletions: string[] = [];
	const url = new URL(options.pathname ?? '/api/settings/ai/oauth/openrouter/start', env.APP_URL);
	const event = {
		url,
		request: new Request(url, { method: 'POST', headers: { Origin: options.requestOrigin ?? env.APP_URL } }),
		locals: { user: { id: identity.userId }, authMethod: options.authMethod ?? 'session', currentSessionId: identity.sessionId },
		platform: { env: { DB: db, ...options.config ?? env } },
		cookies: {
			get: (name: string) => jar.get(name),
			set: (name: string, value: string, cookieOptions: Record<string, unknown>) => {
				jar.set(name, value);
				writes.push({ name, value, options: cookieOptions });
			},
			delete: (name: string) => { jar.delete(name); deletions.push(name); }
		}
	};
	return { event: event as unknown as Parameters<typeof startRoute>[0], jar, writes, deletions };
}

describe('OpenRouter OAuth route contract', () => {
	test('start returns only the authorization URL and sets a secure HttpOnly ten-minute cookie', async () => {
		const { db } = setup();
		const context = routeEvent(db);
		const response = await startRoute(context.event);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		const body = await response.json();
		assert.deepEqual(Object.keys(body), ['url']);
		assert.equal(new URL(body.url).hostname, 'openrouter.ai');
		assert.equal(context.writes.length, 1);
		assert.equal(context.writes[0].name, AI_OAUTH_COOKIE);
		assert.deepEqual(context.writes[0].options, {
			path: AI_OAUTH_COOKIE_PATH, httpOnly: true, secure: true, sameSite: 'lax', maxAge: AI_OAUTH_TTL_SECONDS
		});
		assert.ok(!JSON.stringify(body).includes(context.writes[0].value));
	});

	test('API tokens, mobile sessions, cross-site requests and missing encryption cannot start', async () => {
		for (const [options, expectedStatus] of [
			[{ authMethod: 'api_token' }, 401], [{ authMethod: 'mobile_session' }, 401],
			[{ requestOrigin: 'https://attacker.example' }, 403],
			[{ config: { ...env, ENCRYPTION_KEY: '' } }, 503]
		] as const) {
			const { db } = setup();
			const context = routeEvent(db, options);
			assert.equal((await startRoute(context.event)).status, expectedStatus);
			assert.equal(context.writes.length, 0);
		}
	});

	test('callback redirects with safe status codes and strips authorization codes and provider errors', async () => {
		const { db } = setup();
		const context = routeEvent(db, { pathname: `${AI_OAUTH_CALLBACK_PATH}?code=${key}&state=invalid` });
		const response = await callbackRoute(context.event as unknown as Parameters<typeof callbackRoute>[0]);
		assert.equal(response.status, 303);
		assert.equal(response.headers.get('location'), '/settings/ai?ai_oauth=invalid');
		assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.ok(!JSON.stringify([...response.headers]).includes(key));
		assert.equal(await response.text(), '');
		assert.deepEqual(context.deletions, [AI_OAUTH_COOKIE]);

		const denied = routeEvent(db, { pathname: `${AI_OAUTH_CALLBACK_PATH}?error=access_denied&error_description=${key}` });
		assert.equal((await callbackRoute(denied.event as unknown as Parameters<typeof callbackRoute>[0])).headers.get('location'),
			'/settings/ai?ai_oauth=cancelled');
	});
});

describe('OpenRouter OAuth configuration', () => {
	test('requires encryption and a fixed safe application origin before starting', async () => {
		const { db, sqlite } = setup();
		for (const config of [
			{}, { APP_URL: env.APP_URL }, { ...env, ENCRYPTION_KEY: 'short' },
			{ ...env, APP_URL: 'https://attacker@example.com' },
			{ ...env, APP_URL: 'https://mail.example.com/path' },
			{ ...env, APP_URL: 'http://mail.example.com' }
		]) {
			assert.equal(openRouterOAuthAvailable(config), false);
			await assert.rejects(beginOpenRouterOAuth(db, config, identity, env.APP_URL),
				(error: unknown) => error instanceof AiOAuthError && error.status === 503);
		}
		assert.equal(openRouterOAuthAvailable(env), true);
		assert.equal(openRouterOAuthAvailable({ ...env, APP_URL: 'http://localhost:5173' }), true);
		assert.equal(sqlite.query('SELECT * FROM ai_oauth_transactions').all().length, 0);
	});

	test('cannot start from another origin or with an expired, mobile or first-login session', async () => {
		const { db, sqlite } = setup();
		await assert.rejects(beginOpenRouterOAuth(db, env, identity, 'https://attacker.example'), hasCode('invalid'));
		await assert.rejects(beginOpenRouterOAuth(db, env, { ...identity, sessionId: 'session-2' }, env.APP_URL), hasCode('expired'));
		sqlite.query('UPDATE sessions SET device_platform = ? WHERE id = ?').run('ios', identity.sessionId);
		await assert.rejects(beginOpenRouterOAuth(db, env, identity, env.APP_URL), hasCode('expired'));
		sqlite.query('UPDATE sessions SET device_platform = NULL, expires_at = ? WHERE id = ?').run('2000-01-01', identity.sessionId);
		await assert.rejects(beginOpenRouterOAuth(db, env, identity, env.APP_URL), hasCode('expired'));
		sqlite.query('UPDATE sessions SET expires_at = ? WHERE id = ?').run('2999-01-01', identity.sessionId);
		sqlite.query('UPDATE users SET must_change_password = 1 WHERE id = ?').run(identity.userId);
		await assert.rejects(beginOpenRouterOAuth(db, env, identity, env.APP_URL), hasCode('expired'));
	});
});

describe('OpenRouter authorization transaction', () => {
	test('builds fixed S256 authorization and stores only sealed or hashed transaction secrets', async () => {
		const { db, sqlite } = setup();
		const now = Date.now();
		const started = await beginOpenRouterOAuth(db, env, identity, env.APP_URL, now);
		const url = new URL(started.url);
		assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth');
		assert.equal(url.searchParams.get('callback_url'), env.APP_URL + AI_OAUTH_CALLBACK_PATH);
		assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
		assert.match(url.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{43}$/);
		assert.ok(!started.url.includes(started.browserSecret));
		const rows = sqlite.query('SELECT * FROM ai_oauth_transactions').all();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].expires_at, now + AI_OAUTH_TTL_SECONDS * 1_000);
		assert.equal(rows[0].user_id, identity.userId);
		assert.equal(rows[0].session_id, identity.sessionId);
		assert.ok(!JSON.stringify(rows).includes(started.browserSecret));
		assert.ok(!JSON.stringify(rows).includes(url.searchParams.get('state')!));
		assert.match(String(rows[0].verifier_sealed), /^v1\./);
		assert.equal(await getAiProvider(db, identity.userId), null);
	});

	test('exchanges once with PKCE and installs an encrypted personal free-only provider', async () => {
		const { db, sqlite } = setup();
		const started = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		let verifier = '';
		let calls = 0;
		const fetcher = successfulFetch((url, init) => {
			calls++;
			assert.equal(url, 'https://openrouter.ai/api/v1/auth/keys');
			assert.equal(init.method, 'POST');
			assert.equal(init.redirect, 'manual');
			assert.equal(new Headers(init.headers).get('authorization'), null);
			const body = JSON.parse(String(init.body));
			verifier = body.code_verifier;
			assert.equal(body.code_challenge_method, 'S256');
			assert.equal(body.code, 'test-authorization-code');
		});
		const result = await completeOpenRouterOAuth(db, env, identity, callback(started), fetcher);
		assert.equal(calls, 1);
		assert.equal(result.kind, 'openrouter');
		assert.equal(result.auth_method, 'oauth');
		assert.equal(result.model, 'openrouter/free');
		assert.ok(!JSON.stringify(result).includes(key));
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
		assert.equal(Buffer.from(digest).toString('base64url'), new URL(started.url).searchParams.get('code_challenge'));
		assert.equal((await resolveAiProvider(db, env, identity.userId))?.apiKey, key);
		const stored = sqlite.query('SELECT * FROM ai_providers').all();
		assert.ok(!JSON.stringify(stored).includes(key));
		assert.equal(sqlite.query('SELECT * FROM ai_oauth_transactions').all().length, 0);
		await assert.rejects(completeOpenRouterOAuth(db, env, identity, callback(started), fetcher), hasCode('invalid'));
		assert.equal(calls, 1);
	});

	test('wrong user, changed session, browser cookie, state and origin cannot exchange a code', async () => {
		const { db } = setup();
		const started = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		let calls = 0;
		const fetcher = successfulFetch(() => { calls++; });
		for (const [otherIdentity, overrides] of [
			[{ userId: 'user-2', sessionId: 'session-2' }, {}],
			[{ ...identity, sessionId: 'other-session' }, {}],
			[identity, { browserSecret: 'a'.repeat(43) }],
			[identity, { browserSecret: undefined }],
			[identity, { state: 'a'.repeat(43) }],
			[identity, { state: null }],
			[identity, { requestOrigin: 'https://attacker.example' }]
		] as const) {
			await assert.rejects(completeOpenRouterOAuth(db, env, otherIdentity, { ...callback(started), ...overrides }, fetcher), hasCode('invalid'));
		}
		assert.equal(calls, 0);
		assert.equal(await getAiProvider(db, identity.userId), null);
		await completeOpenRouterOAuth(db, env, identity, callback(started), fetcher);
		assert.equal(calls, 1);
	});

	test('expired state is consumed without exchanging a code', async () => {
		const { db, sqlite } = setup();
		const now = Date.now();
		const started = await beginOpenRouterOAuth(db, env, identity, env.APP_URL, now);
		let calls = 0;
		await assert.rejects(completeOpenRouterOAuth(db, env, identity, callback(started), successfulFetch(() => { calls++; }),
			now + AI_OAUTH_TTL_SECONDS * 1_000), hasCode('expired'));
		assert.equal(calls, 0);
		assert.equal(sqlite.query('SELECT * FROM ai_oauth_transactions').all().length, 0);
	});

	test('concurrent duplicate callbacks exchange only one authorization code', async () => {
		const { db } = setup();
		const started = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		let calls = 0;
		const fetcher = successfulFetch(() => { calls++; });
		const results = await Promise.allSettled([
			completeOpenRouterOAuth(db, env, identity, callback(started), fetcher),
			completeOpenRouterOAuth(db, env, identity, callback(started), fetcher)
		]);
		assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
		assert.equal(calls, 1);
	});

	test('a replaced or cancelled flow cannot replace the current provider', async () => {
		const { db } = setup();
		const first = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		const second = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		await assert.rejects(completeOpenRouterOAuth(db, env, identity, callback(first), successfulFetch()), hasCode('invalid'));
		await cancelOpenRouterOAuth(db, { userId: 'user-2', sessionId: 'session-2' }, second.browserSecret);
		await cancelOpenRouterOAuth(db, identity, second.browserSecret);
		await assert.rejects(completeOpenRouterOAuth(db, env, identity, callback(second), successfulFetch()), hasCode('invalid'));
		assert.equal(await getAiProvider(db, identity.userId), null);
	});

	test('revoking the session before or during exchange prevents connecting the provider', async () => {
		for (const revokeDuringExchange of [false, true]) {
			const { db, sqlite } = setup();
			const started = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
			let calls = 0;
			if (!revokeDuringExchange) sqlite.query('DELETE FROM sessions WHERE id = ?').run(identity.sessionId);
			const fetcher = successfulFetch(() => {
				calls++;
				sqlite.query('DELETE FROM sessions WHERE id = ?').run(identity.sessionId);
			});
			await assert.rejects(completeOpenRouterOAuth(db, env, identity, callback(started), fetcher), hasCode('expired'));
			assert.equal(calls, revokeDuringExchange ? 1 : 0);
			assert.equal(await getAiProvider(db, identity.userId), null);
		}
	});

	test('provider failures never leak response bodies or replace a saved connection', async () => {
		for (const makeResponse of [
			() => Response.json({ error: key }, { status: 403 }),
			() => new Response(null, { status: 307, headers: { Location: `https://attacker.example/${key}` } }),
			() => Response.json({ key: 'invalid' }),
			() => { throw new Error(key); }
		]) {
			const { db } = setup();
			await saveAiProvider(db, env, identity.userId, { kind: 'anthropic', apiKey: 'sk-ant-existing' });
			const started = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
			const fetcher = (async () => makeResponse()) as typeof fetch;
			await assert.rejects(completeOpenRouterOAuth(db, env, identity, callback(started), fetcher), (error: unknown) =>
				error instanceof AiOAuthError && error.code === 'failed' && !error.message.includes(key));
			assert.equal((await resolveAiProvider(db, env, identity.userId))?.apiKey, 'sk-ant-existing');
			await assert.rejects(completeOpenRouterOAuth(db, env, identity, callback(started), successfulFetch()), hasCode('invalid'));
		}
	});

	test('disconnect invalidates an already claimed exchange even without a saved provider', async () => {
		for (const hadProvider of [false, true]) {
			const { db, sqlite } = setup();
			if (hadProvider) await saveAiProvider(db, env, identity.userId, { kind: 'anthropic', apiKey: 'sk-ant-existing' });
			const started = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
			const exchange = delayedExchange();
			const completion = completeOpenRouterOAuth(db, env, identity, callback(started), exchange.fetcher);
			await exchange.started;
			assert.equal(sqlite.query('SELECT * FROM ai_oauth_transactions').all().length, 0);
			await deleteAiProvider(db, identity.userId);
			assert.equal(await getAiProvider(db, identity.userId), null);
			exchange.release();
			await assert.rejects(completion, hasCode('invalid'));
			assert.equal(await getAiProvider(db, identity.userId), null);
		}
	});

	test('disconnect removes pending transactions before a callback claims them', async () => {
		const { db, sqlite } = setup();
		const started = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		await deleteAiProvider(db, identity.userId);
		assert.equal(sqlite.query('SELECT * FROM ai_oauth_transactions').all().length, 0);
		await assert.rejects(completeOpenRouterOAuth(db, env, identity, callback(started), successfulFetch()), hasCode('invalid'));
		assert.equal(await getAiProvider(db, identity.userId), null);
	});

	test('a new flow in another browser session invalidates a previously claimed user exchange', async () => {
		const { db } = setup();
		const first = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		const exchange = delayedExchange();
		const completion = completeOpenRouterOAuth(db, env, identity, callback(first), exchange.fetcher);
		await exchange.started;
		const otherSession = { ...identity, sessionId: 'other-session' };
		const latest = await beginOpenRouterOAuth(db, env, otherSession, env.APP_URL);
		exchange.release();
		await assert.rejects(completion, hasCode('invalid'));
		assert.equal(await getAiProvider(db, identity.userId), null);
		await completeOpenRouterOAuth(db, env, otherSession, callback(latest), successfulFetch());
		assert.equal((await getAiProvider(db, identity.userId))?.auth_method, 'oauth');
	});

	test('manual replacement during exchange wins and the old callback cannot overwrite it', async () => {
		const { db } = setup();
		const first = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		const exchange = delayedExchange();
		const completion = completeOpenRouterOAuth(db, env, identity, callback(first), exchange.fetcher);
		await exchange.started;
		await saveAiProvider(db, env, identity.userId, { kind: 'anthropic', model: 'new-model', apiKey: 'sk-ant-new' });
		exchange.release();
		await assert.rejects(completion, hasCode('invalid'));
		const saved = await resolveAiProvider(db, env, identity.userId);
		assert.equal(saved?.apiKey, 'sk-ant-new');
		assert.equal(saved?.model, 'new-model');
		assert.equal(saved?.kind, 'anthropic');
	});

	test('model edits preserve a connected key and invalidate an older in-flight authorization', async () => {
		const { db } = setup();
		const connected = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		await completeOpenRouterOAuth(db, env, identity, callback(connected), successfulFetch());
		const pending = await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		const exchange = delayedExchange();
		const completion = completeOpenRouterOAuth(db, env, identity, callback(pending), exchange.fetcher);
		await exchange.started;
		await saveAiProvider(db, env, identity.userId, { kind: 'openrouter', model: 'vendor/latest:free' });
		exchange.release();
		await assert.rejects(completion, hasCode('invalid'));
		const saved = await getAiProvider(db, identity.userId);
		assert.equal(saved?.auth_method, 'oauth');
		assert.equal(saved?.model, 'vendor/latest:free');
	});

	test('the provider upsert itself rejects stale generations and revoked sessions', async () => {
		const { db, sqlite } = setup();
		await beginOpenRouterOAuth(db, env, identity, env.APP_URL);
		await deleteAiProvider(db, identity.userId);
		await assert.rejects(saveOpenRouterOAuthProvider(db, env, identity.userId, key, {
			generation: 1, sessionId: identity.sessionId
		}), /connection changed/);
		const row = sqlite.query('SELECT generation FROM ai_connection_generations WHERE user_id = ?').all(identity.userId)[0];
		sqlite.query('DELETE FROM sessions WHERE id = ?').run(identity.sessionId);
		await assert.rejects(saveOpenRouterOAuthProvider(db, env, identity.userId, key, {
			generation: Number(row.generation), sessionId: identity.sessionId
		}), /connection changed/);
		assert.equal(await getAiProvider(db, identity.userId), null);
	});
});

test('AI OAuth migration preserves existing ciphertext and ownership constraints', () => {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	const directory = new URL('../../../migrations/', import.meta.url);
	for (const migration of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0033_ai_oauth.sql').sort()) {
		sqlite.exec(readFileSync(new URL(migration, directory), 'utf8'));
	}
	sqlite.query("INSERT INTO users (id, email, name, password_hash) VALUES ('legacy', 'legacy@example.com', 'Legacy', 'x')").run();
	sqlite.query(`INSERT INTO ai_providers (owner, user_id, kind, model, api_key, key_hint, updated_at)
		VALUES ('legacy', 'legacy', 'anthropic', 'kept-model', 'v1.existing.ciphertext', 'kept', '2026-10-01')`).run();
	sqlite.query("INSERT INTO ai_providers (owner, kind, model) VALUES ('instance', 'workers_ai', 'kept-binding')").run();
	sqlite.exec(readFileSync(new URL('0033_ai_oauth.sql', directory), 'utf8'));
	const row = sqlite.query("SELECT * FROM ai_providers WHERE owner = 'legacy'").get();
	assert.equal(row.api_key, 'v1.existing.ciphertext');
	assert.equal(row.key_hint, 'kept');
	assert.equal(row.updated_at, '2026-10-01');
	assert.equal(row.model, 'kept-model');
	assert.equal(row.auth_method, 'api_key');
	assert.equal(sqlite.query("SELECT auth_method FROM ai_providers WHERE owner = 'instance'").get().auth_method, 'binding');
	assert.throws(() => sqlite.query("INSERT INTO ai_providers (owner, user_id, kind, model) VALUES ('mismatch', 'legacy', 'openrouter', 'openrouter/free')").run());
	assert.throws(() => sqlite.query("UPDATE ai_providers SET kind = 'unsupported' WHERE owner = 'legacy'").run());
	assert.throws(() => sqlite.query("UPDATE ai_providers SET auth_method = 'oauth' WHERE owner = 'legacy'").run());
	sqlite.query("DELETE FROM users WHERE id = 'legacy'").run();
	assert.equal(sqlite.query("SELECT * FROM ai_providers WHERE owner = 'legacy'").get(), null);
});
