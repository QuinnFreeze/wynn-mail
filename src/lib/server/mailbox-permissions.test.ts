import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RequestHandler } from '@sveltejs/kit';
import type { User } from '$lib/types';
import type { ApiScope, AuthMethod } from './api-access';
import { createApiToken, getUserByApiToken } from './api-tokens';
import { getUserById } from './auth';
import { createTestDb, insertTestUser } from './test-db';
import { GET as listAddresses, POST as provisionAddress } from '../../routes/api/addresses/+server';
import { POST as provisionUser } from '../../routes/api/admin/users/+server';
import { PATCH as updateUser } from '../../routes/api/admin/users/[id]/+server';

type Credential = { user: User | null; authMethod: AuthMethod | null; scopes?: readonly ApiScope[] };
type Event = Parameters<RequestHandler>[0];

async function fixture() {
	const storage = createTestDb();
	for (const id of ['owner', 'member', 'other']) insertTestUser(storage.sqlite, id);
	storage.sqlite.query("UPDATE users SET is_admin = 1 WHERE id = 'owner'").run();
	storage.sqlite.query(`INSERT INTO domains (id, name, status, sending_enabled, receiving_enabled)
		VALUES ('mailbox.test', 'mailbox.test', 'verified', 1, 1)`).run();
	for (const id of ['owner', 'member', 'other']) {
		storage.sqlite.query(`INSERT INTO addresses (id, user_id, domain_id, address, is_default)
			VALUES (?, ?, 'mailbox.test', ?, 1)`).run(`${id}-address`, id, `${id}@mailbox.test`);
	}
	const owner = await getUserById(storage.db, 'owner');
	const member = await getUserById(storage.db, 'member');
	assert.ok(owner);
	assert.ok(member);
	return { ...storage, owner, member };
}

function event(
	db: ReturnType<typeof createTestDb>['db'],
	credential: Credential,
	body: unknown,
	path = '/api/addresses',
	params: Record<string, string> = {},
	method = 'POST'
): Event {
	const url = new URL(path, 'https://mail.example.test');
	return {
		request: new Request(url, {
			method, headers: { 'content-type': 'application/json' },
			...(method === 'GET' ? {} : { body: JSON.stringify(body) })
		}),
		url,
		params,
		locals: { user: credential.user, authMethod: credential.authMethod, apiScopes: credential.scopes ?? [] },
		platform: { env: { DB: db } }
	} as unknown as Event;
}

describe('mailbox provisioning permissions through real request handlers', () => {
	test('address creation requires both an allowed credential and the current administrator role', async () => {
		const cases: Array<{
			name: string; actor: 'owner' | 'member' | null; method: AuthMethod | null;
			scopes?: readonly ApiScope[]; status: number;
		}> = [
			{ name: 'anonymous', actor: null, method: null, status: 401 },
			{ name: 'missing credential', actor: 'owner', method: null, status: 401 },
			{ name: 'ordinary browser', actor: 'member', method: 'session', status: 403 },
			{ name: 'ordinary mobile', actor: 'member', method: 'mobile_session', status: 403 },
			{ name: 'administrator mobile', actor: 'owner', method: 'mobile_session', status: 403 },
			{ name: 'ordinary mail token', actor: 'member', method: 'api_token', scopes: ['mail:read', 'mail:send'], status: 403 },
			{ name: 'ordinary admin-scope token', actor: 'member', method: 'api_token', scopes: ['admin'], status: 403 },
			{ name: 'administrator read token', actor: 'owner', method: 'api_token', scopes: ['mail:read'], status: 403 },
			{ name: 'administrator send token', actor: 'owner', method: 'api_token', scopes: ['mail:send'], status: 403 },
			{ name: 'administrator unscoped token', actor: 'owner', method: 'api_token', scopes: [], status: 403 },
			{ name: 'administrator admin-scope token', actor: 'owner', method: 'api_token', scopes: ['admin'], status: 201 },
			{ name: 'administrator browser', actor: 'owner', method: 'session', status: 201 }
		];
		for (const entry of cases) {
			const { db, sqlite, owner, member } = await fixture();
			const actor = entry.actor === 'owner' ? owner : entry.actor === 'member' ? member : null;
			const response = await provisionAddress(event(db,
				{ user: actor, authMethod: entry.method, scopes: entry.scopes },
				{ domainId: 'mailbox.test', localPart: 'assigned', userId: 'other', isAdmin: true }
			));
			assert.equal(response.status, entry.status, entry.name);
			const addresses = sqlite.query("SELECT user_id FROM addresses WHERE address = 'assigned@mailbox.test'").all();
			assert.equal(addresses.length, entry.status === 201 ? 1 : 0, entry.name);
			if (entry.status === 201) assert.equal(addresses[0].user_id, 'other');
			assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM users').all()[0].count, 3);
			assert.equal(sqlite.query("SELECT is_admin FROM users WHERE id = 'other'").all()[0].is_admin, 0);
		}
	});

	test('an administrator can add their own address without changing any account role', async () => {
		const { db, sqlite, owner } = await fixture();
		const response = await provisionAddress(event(db, { user: owner, authMethod: 'session' }, {
			domainId: 'mailbox.test', localPart: 'owner-alias'
		}));
		assert.equal(response.status, 201);
		assert.equal((await response.json()).address.user_id, owner.id);
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1').all()[0].count, 1);
	});

	test('a demoted administrator cannot use an existing admin-scope token to create an address', async () => {
		const { db, sqlite, owner } = await fixture();
		const token = await createApiToken(db, owner.id, { name: 'Synthetic admin token', scopes: ['admin'] });
		sqlite.query('UPDATE users SET is_admin = 0 WHERE id = ?').run(owner.id);
		const authenticated = await getUserByApiToken(db, token.token);
		assert.ok(authenticated);
		assert.equal(authenticated.user.is_admin, false);
		assert.deepEqual(authenticated.scopes, ['admin']);
		const response = await provisionAddress(event(db, {
			user: authenticated.user, authMethod: 'api_token', scopes: authenticated.scopes
		}, { domainId: 'mailbox.test', localPart: 'stale-admin', userId: 'other' }));
		assert.equal(response.status, 403);
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM addresses').all()[0].count, 3);
	});

	test('a missing target account is rejected explicitly even without foreign-key enforcement', async () => {
		const { db, sqlite, owner } = await fixture();
		sqlite.exec('PRAGMA foreign_keys = OFF');
		const response = await provisionAddress(event(db, { user: owner, authMethod: 'session' }, {
			domainId: 'mailbox.test', localPart: 'orphan', userId: 'missing-account'
		}));
		assert.equal(response.status, 404);
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM addresses').all()[0].count, 3);
	});

	test('malformed account assignment fields return 400 without writing an address', async () => {
		const { db, sqlite, owner } = await fixture();
		for (const body of [
			null, [], 'invalid',
			{ domainId: [], localPart: 'invalid' },
			{ domainId: 'mailbox.test', localPart: [] },
			{ domainId: 'mailbox.test', localPart: 'invalid', userId: 1 },
			{ domainId: 'mailbox.test', localPart: 'invalid', userId: '' },
			{ domainId: 'mailbox.test', localPart: 'invalid', userId: 'other', label: [] }
		]) {
			const response = await provisionAddress(event(db, { user: owner, authMethod: 'session' }, body));
			assert.equal(response.status, 400);
		}
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM addresses').all()[0].count, 3);
	});

	test('an ordinary account asking for all addresses still only receives its own', async () => {
		const { db, member } = await fixture();
		const response = await listAddresses(event(db, { user: member, authMethod: 'session' }, {}, '/api/addresses?all=1', {}, 'GET'));
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.deepEqual(body.addresses.map((address: { user_id: string }) => address.user_id), [member.id]);
	});

	test('administrator-created accounts default to ordinary users and require first-login password change', async () => {
		const { db, sqlite, owner } = await fixture();
		const response = await provisionUser(event(db, { user: owner, authMethod: 'session' }, {
			name: 'Invited member', domainId: 'mailbox.test', localPart: 'invited', password: 'synthetic-initial-password'
		}, '/api/admin/users'));
		assert.equal(response.status, 201);
		const body = await response.json();
		assert.equal(body.user.is_admin, false);
		assert.equal(body.user.must_change_password, true);
		assert.equal('password_hash' in body.user, false);
		const stored = sqlite.query("SELECT id, is_admin, must_change_password FROM users WHERE email = 'invited@mailbox.test'").all()[0];
		assert.equal(stored.is_admin, 0);
		assert.equal(stored.must_change_password, 1);
		assert.equal(sqlite.query("SELECT user_id FROM addresses WHERE address = 'invited@mailbox.test'").all()[0].user_id, stored.id);
	});

	test('ordinary accounts cannot create privileged users or promote themselves by forging request fields', async () => {
		const { db, sqlite, member } = await fixture();
		const response = await provisionUser(event(db, { user: member, authMethod: 'session' }, {
			name: 'Forged owner', domainId: 'mailbox.test', localPart: 'forged',
			password: 'synthetic-initial-password', isAdmin: true, userId: 'owner'
		}, '/api/admin/users'));
		assert.equal(response.status, 403);
		const promotion = await updateUser(event(db, { user: member, authMethod: 'session' },
			{ isAdmin: true, userId: 'owner' }, `/api/admin/users/${member.id}`, { id: member.id }, 'PATCH'));
		assert.equal(promotion.status, 403);
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM users').all()[0].count, 3);
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM addresses').all()[0].count, 3);
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1').all()[0].count, 1);
		assert.equal(sqlite.query('SELECT is_admin FROM users WHERE id = ?').all(member.id)[0].is_admin, 0);
	});
});
