import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequestHandler } from '@sveltejs/kit';
import { getUserById } from './auth';
import { createTestDb, insertTestUser } from './test-db';
import { POST } from '../../routes/api/mail/actions/+server';

test('bulk action request handlers enforce current account, category and API scopes', async () => {
	const { db, sqlite } = createTestDb();
	insertTestUser(sqlite);
	insertTestUser(sqlite, 'other');
	for (const [id, user, category, trash] of [
		['primary', 'user-1', 'primary', null], ['social', 'user-1', 'social', null],
		['own-trash', 'user-1', 'primary', '2026-01-01'], ['foreign-trash', 'other', 'primary', '2026-01-01'],
		['foreign-inbox', 'other', 'primary', null]
	]) {
		sqlite.query(`INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,category,deleted_at)
			VALUES (?,?,'inbound','sender@example.net','recipient@example.com','Synthetic',?,?)`).run(id,user,category,trash);
	}
	const user = await getUserById(db, 'user-1');
	async function request(body: unknown, scopes?: string[]) {
		return POST({ request: new Request('https://mail.example.test/api/mail/actions', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
		}), locals: { user, authMethod: scopes ? 'api_token' : 'session', apiScopes: scopes, activeDomainId: null },
		platform: { env: { DB: db } } } as unknown as Parameters<RequestHandler>[0]);
	}
	assert.equal((await request({ action: 'read-all' }, ['mail:read'])).status, 403);
	for (const malformed of [null, [], 'invalid', { action: 'read-all', ids: 'all' }, { action: 'delete', ids: [null] }]) {
		assert.equal((await request(malformed)).status, 400);
	}
	const read = await request({ action: 'read-all', category: 'primary' });
	assert.equal(read.status, 200);
	assert.equal((await read.json()).affected, 1);
	assert.deepEqual(sqlite.query('SELECT id FROM emails WHERE is_read=1').all(), [{ id: 'primary' }]);
	const clear = await request({ action: 'empty-trash', userId: 'other' });
	assert.equal(clear.status, 200);
	assert.equal((await clear.json()).affected, 1);
	assert.deepEqual(sqlite.query('SELECT id FROM emails WHERE deleted_at IS NOT NULL').all(), [{ id: 'foreign-trash' }]);
	assert.equal((await request({ action: 'read-all' }, ['mail:read','mail:send'])).status, 200);
});
