import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RequestHandler } from '@sveltejs/kit';
import type { R2Bucket } from '@cloudflare/workers-types';
import {
	AuthRequestError,
	bootstrapAdmin,
	countUsers,
	createUser,
	createBrowserSession,
	createPairingCode,
	deleteUser,
	getAuthenticatedSession,
	getUserById,
	login,
	loginClientAddress,
	matchesBootstrapToken,
	MAX_AUTH_BODY_BYTES,
	readAuthRequestBody,
	redeemPairingCode,
	setUserPassword
} from './auth';
import { hashToken } from './crypto';
import { createTestDb, insertTestUser } from './test-db';
import { POST as setup } from '../../routes/api/setup/+server';
import { POST as signIn } from '../../routes/api/auth/login/+server';

const TEST_TOKEN = 'test-only-initialization-token';
// example.com is deliberately filtered out as an undeployed template domain.
const TEST_MAIL_DOMAIN = 'mailbox.test';
type Event = Parameters<RequestHandler>[0];

describe('trusted identity session issuance', () => {
	test('issues a normal session only for an initialized mailbox', async () => {
		const { db, sqlite } = createTestDb();
		insertTestUser(sqlite, 'linked-user');
		const result = await createBrowserSession(db, 'linked-user');
		assert.equal(result.user.id, 'linked-user');
		const stored = await db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').bind('linked-user').first<{ token_hash: string }>();
		assert.equal(stored?.token_hash, await hashToken(result.token));
		sqlite.exec("UPDATE users SET must_change_password = 1 WHERE id = 'linked-user'");
		await assert.rejects(createBrowserSession(db, 'linked-user'), AuthRequestError);
		await assert.rejects(createBrowserSession(db, 'missing-user'), AuthRequestError);
		assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM sessions').first<{count: number}>())?.count, 1);
	});
});

describe('password rotation', () => {
	test('refuses a login verified against a password changed before session insertion', async () => {
		const { db, sqlite } = createTestDb();
		const user = await createUser(db, {
			email: 'reset-user@mailbox.test', name: 'Reset user', password: 'test-only-old-password'
		});
		let releaseInsert!: () => void;
		let reportInsert!: () => void;
		const insertReady = new Promise<void>((resolve) => { reportInsert = resolve; });
		const insertAllowed = new Promise<void>((resolve) => { releaseInsert = resolve; });
		const pausedDb = new Proxy(db, {
			get(target, property) {
				if (property !== 'prepare') {
					const value = Reflect.get(target, property, target);
					return typeof value === 'function' ? value.bind(target) : value;
				}
				return (sql: string) => {
					const statement = target.prepare(sql);
					if (!/INSERT\s+INTO\s+sessions\b/i.test(sql)) return statement;
					const run = statement.run.bind(statement);
					statement.run = (async () => {
						reportInsert();
						await insertAllowed;
						return run();
					}) as typeof statement.run;
					return statement;
				};
			}
		});

		const inFlightLogin = login(pausedDb, user.email, 'test-only-old-password');
		await Promise.race([
			insertReady,
			inFlightLogin.then(() => assert.fail('Login did not reach session insertion'))
		]);
		try {
			await setUserPassword(db, user.id, 'test-only-new-password');
		} finally {
			releaseInsert();
		}
		assert.equal(Boolean(await inFlightLogin), false);
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM sessions').all()[0]?.count, 0);
		assert.equal(Boolean(await login(db, user.email, 'test-only-old-password')), false);
		const freshLogin = await login(db, user.email, 'test-only-new-password');
		assert.ok(freshLogin);
		assert.equal((await getAuthenticatedSession(db, freshLogin.token))?.user.id, user.id);
	});

	test('revokes old pairing codes and sessions while allowing fresh pairing and preserving other users', async () => {
		const { db, sqlite } = createTestDb();
		insertTestUser(sqlite, 'reset-user');
		insertTestUser(sqlite, 'other-user');
		const oldSession = await createBrowserSession(db, 'reset-user');
		const otherSession = await createBrowserSession(db, 'other-user');
		const oldPairings = await Promise.all([
			createPairingCode(db, 'reset-user'),
			createPairingCode(db, 'reset-user')
		]);
		const otherPairing = await createPairingCode(db, 'other-user');

		await setUserPassword(db, 'reset-user', 'test-only-reset-password');

		assert.equal(await getAuthenticatedSession(db, oldSession.token), null);
		assert.equal((await getAuthenticatedSession(db, otherSession.token))?.user.id, 'other-user');
		for (const pairing of oldPairings) {
			assert.equal(Boolean(await redeemPairingCode(db, pairing.code, { name: 'Old device' })), false);
		}
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM sessions').all()[0]?.count, 1);

		const otherDevice = await redeemPairingCode(db, otherPairing.code, { name: 'Other device' });
		assert.ok(otherDevice);
		assert.equal((await getAuthenticatedSession(db, otherDevice.token))?.user.id, 'other-user');
		const freshPairing = await createPairingCode(db, 'reset-user');
		const freshDevice = await redeemPairingCode(db, freshPairing.code, { name: 'Fresh device' });
		assert.ok(freshDevice);
		assert.equal((await getAuthenticatedSession(db, freshDevice.token))?.user.id, 'reset-user');
		assert.equal(Boolean(await redeemPairingCode(db, freshPairing.code, { name: 'Replay' })), false);
	});
});

function event(
	db: ReturnType<typeof createTestDb>['db'],
	body: unknown,
	options: { token?: string; url?: string; ip?: string; headerIp?: string } = {}
): Event {
	const url = new URL(options.url ?? 'https://mail.example.com/api/setup');
	const request = new Request(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(options.headerIp ? { 'cf-connecting-ip': options.headerIp } : {})
		},
		body: JSON.stringify(body)
	});
	return {
		request,
		url,
		platform: {
			env: {
				DB: db,
				BOOTSTRAP_TOKEN: options.token ?? TEST_TOKEN,
				EMAIL_PROVIDER: 'cloudflare',
				CLOUDFLARE_MAIL_DOMAINS: TEST_MAIL_DOMAIN,
				EMAIL: { send: async () => ({ messageId: 'unused' }) }
			}
		},
		cookies: { get: () => undefined, set: () => undefined },
		getClientAddress: () => options.ip ?? '198.51.100.10'
	} as unknown as Event;
}

function setupBody(overrides: Record<string, unknown> = {}) {
	return {
		bootstrapToken: TEST_TOKEN,
		domainId: TEST_MAIL_DOMAIN,
		localPart: 'ada',
		name: 'Ada',
		password: 'test-only-password',
		...overrides
	};
}

describe('private mailbox bootstrap', () => {
	test('fails closed without a configured token, including whitespace-only secrets', async () => {
		for (const token of ['', '   ']) {
			const { db } = createTestDb();
			const response = await setup(event(db, setupBody(), { token }));
			assert.equal(response.status, 503);
			assert.equal(await countUsers(db), 0);
		}
	});

	test('does not accept missing, incorrect, or non-string initialization tokens', async () => {
		const { db } = createTestDb();
		for (const bootstrapToken of [undefined, '', 'incorrect', { token: TEST_TOKEN }]) {
			const response = await setup(event(db, setupBody({ bootstrapToken })));
			assert.equal(response.status, 403);
		}
		assert.equal(await countUsers(db), 0);
	});

	test('rejects invalid fields before creating an administrator', async () => {
		const { db } = createTestDb();
		for (const overrides of [
			{ name: { text: 'Ada' } },
			{ name: 'x'.repeat(201) },
			{ localPart: 'invalid@other.example' },
			{ password: 'x'.repeat(1025) },
			{ domainId: [] }
		]) {
			const response = await setup(event(db, setupBody(overrides)));
			assert.equal(response.status, 400);
		}
		assert.equal(await countUsers(db), 0);
	});

	test('creates one administrator and refuses subsequent initialization', async () => {
		const { db } = createTestDb();
		const first = await setup(event(db, setupBody()));
		const body = await first.json();
		assert.equal(first.status, 200, JSON.stringify(body));
		assert.equal(body.email, `ada@${TEST_MAIL_DOMAIN}`);
		const second = await setup(event(db, setupBody({ localPart: 'grace' })));
		assert.equal(second.status, 400);
		assert.equal(await countUsers(db), 1);
	});

	test('competing first-user claims cannot both become administrators', async () => {
		const { db, sqlite } = createTestDb();
		const results = await Promise.allSettled([
			bootstrapAdmin(db, { email: 'ada@example.com', name: 'Ada', password: 'password-one' }),
			bootstrapAdmin(db, { email: 'grace@example.com', name: 'Grace', password: 'password-two' })
		]);
		assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
		assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
		assert.equal(await countUsers(db), 1);
		assert.equal(sqlite.query('SELECT is_admin FROM users').all()[0]?.is_admin, 1);
	});

	test('the native comparison handles different lengths and rejects empty tokens', async () => {
		assert.equal(await matchesBootstrapToken(TEST_TOKEN, TEST_TOKEN), true);
		assert.equal(await matchesBootstrapToken(`${TEST_TOKEN}x`, TEST_TOKEN), false);
		assert.equal(await matchesBootstrapToken(TEST_TOKEN.slice(1), TEST_TOKEN), false);
		assert.equal(await matchesBootstrapToken('', ''), false);
	});
});

describe('account deletion with raw message archives', () => {
	test('removes the target account archives and attachments while preserving other accounts', async () => {
		const { db, sqlite } = createTestDb();
		for (const userId of ['owner', 'target', 'other']) insertTestUser(sqlite, userId);
		sqlite.query('UPDATE users SET is_admin = 1 WHERE id = ?').run('owner');
		for (const userId of ['target', 'other']) {
			sqlite.query(
				`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject, raw_storage_key)
				 VALUES (?, ?, 'inbound', 'sender@external.test', ?, 'archive', ?)`
			).run(`mail-${userId}`, userId, `${userId}@mailbox.test`, `raw/${userId}.eml`);
			sqlite.query(
				`INSERT INTO email_attachments
				 (id, email_id, filename, content_type, size_bytes, content_base64, storage_key)
				 VALUES (?, ?, 'file.txt', 'text/plain', 1, '', ?)`
			).run(`attachment-${userId}`, `mail-${userId}`, `attachments/${userId}`);
		}
		const deleted: string[] = [];
		const bucket = { delete: async (key: string) => { deleted.push(key); } } as unknown as R2Bucket;
		const owner = await getUserById(db, 'owner');
		assert.ok(owner);

		await deleteUser(db, bucket, owner, 'target');

		assert.deepEqual(deleted.sort(), ['attachments/target', 'raw/target.eml']);
		assert.equal(await getUserById(db, 'target'), null);
		assert.equal(sqlite.query("SELECT id FROM emails WHERE user_id = 'target'").all().length, 0);
		assert.equal(sqlite.query("SELECT id FROM email_attachments WHERE id = 'attachment-target'").all().length, 0);
		assert.equal(sqlite.query("SELECT raw_storage_key FROM emails WHERE user_id = 'other'").all()[0]?.raw_storage_key,
			'raw/other.eml');
		assert.equal(sqlite.query("SELECT id FROM email_attachments WHERE id = 'attachment-other'").all().length, 1);
	});
});

describe('bounded authentication requests', () => {
	test('only accepts a JSON object', async () => {
		for (const body of ['null', '[]', '"text"', '{']) {
			const request = new Request('https://mail.example.com', {
				method: 'POST', headers: { 'content-type': 'application/json' }, body
			});
			await assert.rejects(() => readAuthRequestBody(request), (error: unknown) =>
				error instanceof AuthRequestError && error.status === 400);
		}
	});

	test('rejects a non-JSON content type', async () => {
		const request = new Request('https://mail.example.com', { method: 'POST', body: '{}' });
		await assert.rejects(() => readAuthRequestBody(request), (error: unknown) =>
			error instanceof AuthRequestError && error.status === 415);
	});

	test('rejects oversized chunked bodies even when Content-Length claims otherwise', async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_AUTH_BODY_BYTES));
				controller.enqueue(new Uint8Array(1));
			},
			cancel() { cancelled = true; }
		});
		const request = new Request('https://mail.example.com', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': '1' },
			body,
			duplex: 'half'
		} as RequestInit);
		await assert.rejects(() => readAuthRequestBody(request), (error: unknown) =>
			error instanceof AuthRequestError && error.status === 413);
		assert.equal(cancelled, true);
	});
});

describe('login throttling and trusted client addresses', () => {
	test('ignores forged CF headers without trusted edge metadata', () => {
		const request = new Request('https://mail.example.com', {
			headers: { 'cf-connecting-ip': '203.0.113.99' }
		});
		assert.equal(loginClientAddress(request, () => '198.51.100.10'), '198.51.100.10');
		Object.defineProperty(request, 'cf', { value: { colo: 'LHR' } });
		assert.equal(loginClientAddress(request, () => '198.51.100.10'), '203.0.113.99');
	});

	test('ignores forged CF headers on localhost even with simulated edge metadata', () => {
		const request = new Request('http://localhost:5173', {
			headers: { 'cf-connecting-ip': '203.0.113.99' }
		});
		Object.defineProperty(request, 'cf', { value: { colo: 'LHR' } });
		assert.equal(loginClientAddress(request, () => '127.0.0.1'), '127.0.0.1');
	});

	test('normalizes login identities and enforces one email limit across IPs', async () => {
		const { db, sqlite } = createTestDb();
		for (let attempt = 0; attempt < 11; attempt++) {
			const response = await signIn(event(db, {
				email: attempt % 2 ? ' ADA@EXAMPLE.COM ' : 'ada@example.com', password: 'incorrect'
			}, { ip: `198.51.100.${attempt + 1}` }));
			assert.equal(response.status, attempt < 10 ? 401 : 429);
		}
		const rows = sqlite.query("SELECT key FROM rate_limits WHERE key LIKE 'login-email:%'").all();
		assert.deepEqual(rows.map((row) => row.key), [`login-email:${await hashToken('ada@example.com')}`]);
	});

	test('rotating an untrusted header cannot evade the per-IP limit', async () => {
		const { db } = createTestDb();
		for (let attempt = 0; attempt < 31; attempt++) {
			const requestEvent = event(db, {
				email: `user${attempt}@example.com`, password: 'incorrect'
			}, { url: 'http://localhost:5173/api/auth/login', headerIp: `203.0.113.${attempt + 1}` });
			Object.defineProperty(requestEvent.request, 'cf', { value: { colo: 'LHR' } });
			const response = await signIn(requestEvent);
			assert.equal(response.status, attempt < 30 ? 401 : 429);
			if (attempt === 30) assert.equal(response.headers.get('retry-after'), '300');
		}
	});

	test('rejects malformed credential fields without throwing', async () => {
		const { db } = createTestDb();
		for (const body of [
			{ email: {}, password: 'password' },
			{ email: 'ada@example.com', password: {} },
			{ email: 'ada@example.com', password: 'x'.repeat(1025) },
			{ email: 'ada@example.com', password: 'password', add: 'yes' }
		]) {
			assert.equal((await signIn(event(db, body))).status, 400);
		}
	});

	test('valid credentials still sign in after email normalization', async () => {
		const { db } = createTestDb();
		await createUser(db, { email: 'ada@example.com', name: 'Ada', password: 'test-only-password' });
		const response = await signIn(event(db, {
			email: ' ADA@EXAMPLE.COM ', password: 'test-only-password'
		}));
		assert.equal(response.status, 200);
		assert.equal((await response.json()).user.email, 'ada@example.com');
	});
});
