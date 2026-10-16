import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { RequestHandler } from '@sveltejs/kit';
// @ts-expect-error bun:sqlite exists under `bun test`; bun's types are not installed.
import { Database } from 'bun:sqlite';
import { getUserById } from './auth';
import { createTestDb, insertTestUser } from './test-db';
import { getMailRetentionSettings, runMailRetention, setMailRetentionSettings } from './mail-retention';
import { GET, PATCH } from '../../routes/api/settings/mail-retention/+server';

const NOW = Date.UTC(2026, 9, 16, 12);
const DEFAULTS = { readEnabled: false, readDays: 30, trashEnabled: false, trashDays: 30 };
const ENABLED = { ...DEFAULTS, readEnabled: true, trashEnabled: true };
type Fixture = ReturnType<typeof createTestDb>;
type Event = Parameters<RequestHandler>[0];

function fixture() {
	const f = createTestDb();
	insertTestUser(f.sqlite);
	insertTestUser(f.sqlite, 'other');
	return f;
}

function mail(f: Fixture, id: string, changes: Record<string, string | number | null> = {}) {
	f.sqlite.query(`INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject)
		VALUES (?,'user-1','inbound','sender@example.test','recipient@example.test','Synthetic retention test')`).run(id);
	// Apply read_at separately because a read transition intentionally resets it.
	const { read_at, ...flags } = changes;
	if (Object.keys(flags).length) {
		f.sqlite.query(`UPDATE emails SET ${Object.keys(flags).map((key) => `${key} = ?`).join(',')} WHERE id = ?`)
			.run(...Object.values(flags), id);
	}
	if (read_at !== undefined) f.sqlite.query('UPDATE emails SET read_at = ? WHERE id = ?').run(read_at, id);
}

function row(f: Fixture, id: string) { return f.sqlite.query('SELECT * FROM emails WHERE id = ?').all(id)[0]; }

async function event(f: Fixture, body?: unknown, options: {
	method?: 'GET' | 'PATCH'; authMethod?: string | null; userId?: string; sessionId?: string | null;
	origin?: string | null; mustChange?: boolean;
} = {}): Promise<Event> {
	const user = await getUserById(f.db, options.userId ?? 'user-1');
	if (user && options.mustChange) user.must_change_password = true;
	const url = new URL('https://mail.example.test/api/settings/mail-retention');
	const method = options.method ?? 'PATCH';
	return {
		url,
		request: new Request(url, { method, headers: {
			'content-type': 'application/json',
			...(options.origin === null ? {} : { origin: options.origin ?? url.origin })
		}, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }),
		locals: { user, authMethod: options.authMethod === undefined ? 'session' : options.authMethod,
			currentSessionId: options.sessionId === undefined ? 'synthetic-session' : options.sessionId },
		platform: { env: { DB: f.db } }
	} as unknown as Event;
}

describe('retention settings through real handlers', () => {
	test('defaults off and saves the complete policy only for the current account', async () => {
		const f = fixture();
		const initial = await GET(await event(f, undefined, { method: 'GET' }));
		assert.equal(initial.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await initial.json(), DEFAULTS);
		const policy = { readEnabled: true, readDays: 7, trashEnabled: true, trashDays: 3650 };
		const response = await PATCH(await event(f, policy));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), policy);
		assert.deepEqual(await getMailRetentionSettings(f.db, 'user-1'), policy);
		assert.deepEqual(await getMailRetentionSettings(f.db, 'other'), DEFAULTS);
	});

	test('rejects bearer/mobile credentials, missing sessions and first-login accounts', async () => {
		const f = fixture();
		for (const authMethod of ['api_token', 'mobile_session', null]) {
			assert.equal((await GET(await event(f, undefined, { method: 'GET', authMethod }))).status, 401);
			assert.equal((await PATCH(await event(f, ENABLED, { authMethod }))).status, 401);
		}
		assert.equal((await PATCH(await event(f, ENABLED, { sessionId: null }))).status, 401);
		assert.equal((await PATCH(await event(f, ENABLED, { mustChange: true }))).status, 403);
		assert.deepEqual(await getMailRetentionSettings(f.db, 'user-1'), DEFAULTS);
	});

	test('requires the exact same origin before accepting JSON', async () => {
		const f = fixture();
		for (const origin of [null, 'null', 'https://outside.example.test', 'https://mail.example.test.evil.test']) {
			assert.equal((await PATCH(await event(f, ENABLED, { origin }))).status, 403);
		}
		assert.deepEqual(await getMailRetentionSettings(f.db, 'user-1'), DEFAULTS);
	});

	test('rejects partial, coerced, extra-account and out-of-range policies without writes', async () => {
		const f = fixture();
		for (const body of [
			null, [], {}, { readEnabled: true }, { ...ENABLED, userId: 'other' }, { ...ENABLED, isAdmin: true },
			{ ...ENABLED, readEnabled: 1 }, { ...ENABLED, trashEnabled: 'true' },
			{ ...ENABLED, readDays: '7' }, { ...ENABLED, readDays: 0 }, { ...ENABLED, readDays: 1.5 },
			{ ...ENABLED, trashDays: -1 }, { ...ENABLED, trashDays: 3651 }, { ...ENABLED, trashDays: null }
		]) assert.equal((await PATCH(await event(f, body))).status, 400);
		assert.deepEqual(await getMailRetentionSettings(f.db, 'user-1'), DEFAULTS);
	});
});

describe('read timestamps maintained by database triggers', () => {
	test('initializes inserted read mail, preserves repeated reads, clears unread, and resets restored read mail', () => {
		const f = fixture();
		mail(f, 'read', { is_read: 1 });
		assert.ok(row(f, 'read').read_at);
		f.sqlite.query("UPDATE emails SET read_at = '2000-01-01 00:00:00' WHERE id = 'read'").run();
		f.sqlite.query("UPDATE emails SET is_read = 1 WHERE id = 'read'").run();
		assert.equal(row(f, 'read').read_at, '2000-01-01 00:00:00');
		f.sqlite.query("UPDATE emails SET deleted_at = '2001-01-01 00:00:00' WHERE id = 'read'").run();
		assert.equal(row(f, 'read').read_at, '2000-01-01 00:00:00');
		f.sqlite.query("UPDATE emails SET deleted_at = NULL WHERE id = 'read'").run();
		assert.notEqual(row(f, 'read').read_at, '2000-01-01 00:00:00');
		f.sqlite.query("UPDATE emails SET is_read = 0 WHERE id = 'read'").run();
		assert.equal(row(f, 'read').read_at, null);
		f.sqlite.query("UPDATE emails SET is_read = 1 WHERE id = 'read'").run();
		assert.ok(row(f, 'read').read_at);
		f.sqlite.query(`INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,is_read)
			VALUES ('insert-read','user-1','inbound','a@example.test','b@example.test','Synthetic',1)`).run();
		assert.ok(row(f, 'insert-read').read_at);
	});

	test('backfills old read messages at migration time and leaves unread messages unstarted', () => {
		const sqlite = new Database(':memory:');
		const directory = new URL('../../../migrations/', import.meta.url);
		for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0034').sort()) {
			sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
		}
		sqlite.exec(`INSERT INTO users(id,email,name,password_hash) VALUES('legacy','legacy@example.test','Legacy','x');
			INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,is_read,created_at) VALUES
			('old-read','legacy','inbound','a@example.test','b@example.test','Synthetic',1,'2000-01-01'),
			('old-unread','legacy','inbound','a@example.test','b@example.test','Synthetic',0,'2000-01-01');`);
		const before = sqlite.query("SELECT datetime('now') AS time").get().time;
		sqlite.exec(readFileSync(new URL('0034_mail_retention.sql', directory), 'utf8'));
		const after = sqlite.query("SELECT datetime('now') AS time").get().time;
		const readAt = sqlite.query("SELECT read_at FROM emails WHERE id = 'old-read'").get().read_at;
		assert.ok(readAt >= before && readAt <= after);
		assert.equal(sqlite.query("SELECT read_at FROM emails WHERE id = 'old-unread'").get().read_at, null);
	});

	test('bumps mailbox epochs for real read/trash changes without counting a repeated read', () => {
		const f = fixture();
		mail(f, 'epoch');
		const epoch = () => f.sqlite.query("SELECT mailbox_epoch FROM users WHERE id = 'user-1'").all()[0].mailbox_epoch;
		const before = Number(epoch());
		f.sqlite.query("UPDATE emails SET is_read = 1 WHERE id = 'epoch'").run();
		assert.equal(epoch(), before + 1);
		f.sqlite.query("UPDATE emails SET is_read = 1 WHERE id = 'epoch'").run();
		assert.equal(epoch(), before + 1);
		f.sqlite.query("UPDATE emails SET deleted_at = '2026-01-01' WHERE id = 'epoch'").run();
		f.sqlite.query("UPDATE emails SET deleted_at = NULL WHERE id = 'epoch'").run();
		assert.equal(epoch(), before + 3);
	});
});

describe('bounded retention runs', () => {
	test('does nothing until each owner independently opts in', async () => {
		const f = fixture();
		mail(f, 'read', { is_read: 1, read_at: '2000-01-01' });
		mail(f, 'trash', { deleted_at: '2000-01-01' });
		assert.deepEqual(await runMailRetention(f.db, undefined, NOW), { trashed: 0, deleted: 0 });
		assert.ok(row(f, 'trash'));
		assert.equal(row(f, 'read').deleted_at, null);
	});

	test('moves only due ordinary inbound read mail and preserves protected states and other accounts', async () => {
		const f = fixture();
		await setMailRetentionSettings(f.db, 'user-1', ENABLED);
		const due = { is_read: 1, read_at: '2026-09-16 12:00:00' };
		mail(f, 'due', due);
		mail(f, 'recent', { ...due, read_at: '2026-09-16 12:00:01' });
		const protectedStates: Record<string, Record<string, string | number | null>> = {
			unread: { is_read: 0 }, sent: { direction: 'outbound' }, draft: { status: 'draft' }, starred: { is_starred: 1 },
			archive: { archived_at: '2026-01-01' }, spam: { spam_at: '2026-01-01' },
			trash: { deleted_at: '2026-10-16 11:00:00' }, foreign: { user_id: 'other' }
		};
		for (const [id, flags] of Object.entries(protectedStates)) mail(f, id, { ...due, ...flags });
		assert.deepEqual(await runMailRetention(f.db, undefined, NOW), { trashed: 1, deleted: 0 });
		assert.equal(row(f, 'due').deleted_at, '2026-10-16 12:00:00');
		for (const id of ['recent', 'unread', 'sent', 'draft', 'starred', 'archive', 'spam', 'foreign']) assert.equal(row(f, id).deleted_at, null, id);
		assert.equal(row(f, 'trash').deleted_at, '2026-10-16 11:00:00');
		assert.deepEqual(await runMailRetention(f.db, undefined, NOW), { trashed: 0, deleted: 0 });
	});

	test('deletes only due Trash in one DB transaction and queues raw/attachment keys without touching storage', async () => {
		const f = fixture();
		await setMailRetentionSettings(f.db, 'user-1', ENABLED);
		mail(f, 'due', { deleted_at: '2026-09-16 12:00:00', raw_storage_key: 'raw/a' });
		mail(f, 'recent', { deleted_at: '2026-09-16 12:00:01' });
		mail(f, 'inbox', { is_read: 1, read_at: '2026-10-01' });
		mail(f, 'foreign', { user_id: 'other', deleted_at: '2000-01-01' });
		f.sqlite.query(`INSERT INTO email_attachments(id,email_id,filename,content_type,size_bytes,content_base64,storage_key)
			VALUES('file','due','synthetic.txt','text/plain',1,'','file/a')`).run();
		const bucket = { delete() { assert.fail('Retention must leave object cleanup to the worker'); } } as unknown as R2Bucket;
		assert.deepEqual(await runMailRetention(f.db, bucket, NOW), { trashed: 0, deleted: 1 });
		assert.equal(row(f, 'due'), undefined);
		for (const id of ['recent', 'inbox', 'foreign']) assert.ok(row(f, id), id);
		assert.deepEqual(f.sqlite.query('SELECT storage_key FROM mail_storage_cleanup ORDER BY storage_key').all(),
			[{ storage_key: 'file/a' }, { storage_key: 'raw/a' }]);
	});

	test('caps each run at 80 permanent deletions and 200 read moves', async () => {
		const f = fixture();
		await setMailRetentionSettings(f.db, 'user-1', ENABLED);
		for (let i = 0; i < 81; i++) mail(f, `trash-${i}`, { deleted_at: '2000-01-01' });
		for (let i = 0; i < 201; i++) mail(f, `read-${i}`, { is_read: 1, read_at: '2000-01-01' });
		assert.deepEqual(await runMailRetention(f.db, undefined, NOW), { trashed: 200, deleted: 80 });
		assert.equal(f.sqlite.query('SELECT COUNT(*) AS n FROM emails WHERE deleted_at IS NULL').all()[0].n, 1);
		assert.deepEqual(await runMailRetention(f.db, undefined, NOW), { trashed: 1, deleted: 1 });
	});

	test('rechecks a disabled/extended policy or restored message immediately before the delete transaction', async () => {
		for (const change of [
			"UPDATE users SET mail_retention_trash_enabled = 0 WHERE id = 'user-1'",
			"UPDATE users SET mail_retention_trash_days = 3650 WHERE id = 'user-1'",
			"UPDATE emails SET deleted_at = NULL WHERE id = 'due'"
		]) {
			const f = fixture();
			await setMailRetentionSettings(f.db, 'user-1', ENABLED);
			mail(f, 'due', { deleted_at: '2026-09-01' });
			const racingDb = new Proxy(f.db, { get(target, property) {
				if (property === 'batch') return async (statements: Parameters<D1Database['batch']>[0]) => {
					f.sqlite.exec(change);
					return target.batch(statements);
				};
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			} });
			assert.deepEqual(await runMailRetention(racingDb, undefined, NOW), { trashed: 0, deleted: 0 }, change);
			assert.ok(row(f, 'due'));
			assert.equal(f.sqlite.query('SELECT COUNT(*) AS n FROM mail_storage_cleanup').all()[0].n, 0);
		}
	});

	test('rechecks current flags and settings before the bounded read update', async () => {
		for (const change of [
			"UPDATE users SET mail_retention_read_enabled = 0 WHERE id = 'user-1'",
			"UPDATE users SET mail_retention_read_days = 3650 WHERE id = 'user-1'",
			"UPDATE emails SET is_read = 0 WHERE id = 'due'",
			"UPDATE emails SET is_starred = 1 WHERE id = 'due'",
			"UPDATE emails SET archived_at = '2026-10-16' WHERE id = 'due'"
		]) {
			const f = fixture();
			await setMailRetentionSettings(f.db, 'user-1', ENABLED);
			mail(f, 'due', { is_read: 1, read_at: '2026-09-01' });
			const racingDb = new Proxy(f.db, { get(target, property) {
				if (property !== 'prepare') {
					const value = Reflect.get(target, property, target);
					return typeof value === 'function' ? value.bind(target) : value;
				}
				return (sql: string) => {
					const statement = target.prepare(sql);
					if (sql.startsWith('UPDATE emails AS e')) {
						const all = statement.all.bind(statement);
						statement.all = (async () => { f.sqlite.exec(change); return all(); }) as typeof statement.all;
					}
					return statement;
				};
			} });
			assert.deepEqual(await runMailRetention(racingDb, undefined, NOW), { trashed: 0, deleted: 0 }, change);
			assert.equal(row(f, 'due').deleted_at, null);
		}
	});
});
