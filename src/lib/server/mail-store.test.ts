import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { EmailRow } from '$lib/types';
import { buildThreadParticipants } from './thread-participants';
import {
	countUnclassifiedInbound,
	deleteEmailsPermanently,
	getMailboxCounts,
	getMailboxCursor,
	listForwardThreadMessages,
	listUnclassifiedInbound,
	markAllRead,
	UNCLASSIFIED_INBOUND_WHERE
} from './mail-store';
import { createTestDb, insertTestUser } from './test-db';
import { drainMailStorageCleanup } from './mail-deletion';

describe('thread participants', () => {
	test('supplies a real inbound display name', () => {
		assert.deepEqual(
			buildThreadParticipants([
				{
					direction: 'inbound',
					from_addr: 'jane@example.com',
					from_name: 'Jane Smith',
					to_addr: 'me@example.com'
				}
			]),
			[{ label: 'Jane Smith', address: 'jane@example.com', self: false }]
		);
	});

	test('supplies recipients for sent-only and draft threads', () => {
		assert.deepEqual(
			buildThreadParticipants([
				{
					direction: 'outbound',
					from_addr: 'Me <me@example.com>',
					from_name: 'Me',
					to_addr: 'Jane Smith <jane@example.com>, sam@example.com'
				}
			]),
			[
				{ label: 'me', address: 'me@example.com', self: true },
				{ label: 'Jane Smith', address: 'jane@example.com', self: false },
				{ label: 'sam@example.com', address: 'sam@example.com', self: false }
			]
		);
	});

	test('enriches an address-only participant when a later message supplies a name', () => {
		assert.deepEqual(
			buildThreadParticipants([
				{
					direction: 'outbound',
					from_addr: 'me@example.com',
					from_name: 'Me',
					to_addr: 'jane@example.com'
				},
				{
					direction: 'inbound',
					from_addr: 'jane@example.com',
					from_name: 'Jane Smith',
					to_addr: 'me@example.com'
				}
			]),
			[
				{ label: 'me', address: 'me@example.com', self: true },
				{ label: 'Jane Smith', address: 'jane@example.com', self: false }
			]
		);
	});

	test('collapses multiple sending identities into one self participant', () => {
		assert.deepEqual(
			buildThreadParticipants([
				{
					direction: 'outbound',
					from_addr: 'first@example.com',
					from_name: 'First Mailbox',
					to_addr: 'jane@example.com'
				},
				{
					direction: 'outbound',
					from_addr: 'second@example.com',
					from_name: 'Second Mailbox',
					to_addr: 'jane@example.com'
				}
			]),
			[
				{ label: 'me', address: 'first@example.com', self: true },
				{ label: 'jane@example.com', address: 'jane@example.com', self: false }
			]
		);
	});
});

test('forward-thread lookup rejects cross-user messages and returns the owned thread oldest first', async () => {
	const rows = [
		{ id: 'newer', user_id: 'user-1', thread_id: 'thread-1', created_at: '2026-02-02' },
		{ id: 'other-user', user_id: 'user-2', thread_id: 'thread-1', created_at: '2026-01-01' },
		{ id: 'older', user_id: 'user-1', thread_id: 'thread-1', created_at: '2026-02-01' },
		{
			id: 'trashed',
			user_id: 'user-1',
			thread_id: 'thread-1',
			created_at: '2026-02-03',
			deleted_at: '2026-02-04'
		},
		{ id: 'other-thread', user_id: 'user-1', thread_id: 'thread-2', created_at: '2026-01-01' }
	] as EmailRow[];
	const db = {
		prepare(sql: string) {
			assert.match(sql, /user_id = \?/);
			assert.match(sql, /COALESCE\(thread_id, id\) = \?/);
			assert.match(sql, /deleted_at IS NULL/);
			return {
				bind(userId: string, threadId: string) {
					return {
						async all() {
							return {
								results: rows
									.filter(
										(row) =>
											row.user_id === userId &&
											(row.thread_id ?? row.id) === threadId &&
											!row.deleted_at
									)
									.sort((a, b) => a.created_at.localeCompare(b.created_at))
							};
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	assert.deepEqual(
		(await listForwardThreadMessages(db, 'user-1', 'thread-1')).map((row) => row.id),
		['older', 'newer']
	);
	assert.deepEqual(await listForwardThreadMessages(db, 'user-3', 'thread-1'), []);
});

test('mailbox cursor reads one users row, not the mailbox', async () => {
	const queries: { sql: string; binds: unknown[] }[] = [];
	const db = {
		prepare(sql: string) {
			return {
				bind(...binds: unknown[]) {
					queries.push({ sql, binds });
					return {
						async first() {
							return { mailbox_epoch: 7 };
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	assert.equal(await getMailboxCursor(db, 'user-1'), '7');
	assert.equal(queries.length, 1);
	assert.match(queries[0].sql, /FROM users WHERE id = \?/);
	assert.doesNotMatch(queries[0].sql, /emails/);
	assert.deepEqual(queries[0].binds, ['user-1']);
});

test('mailbox counts keep Primary unread separate from Social and exclude spam from every tab', async () => {
	let sql = '';
	const db = {
		prepare(query: string) {
			sql = query;
			return {
				bind() {
					return {
						async first() {
							return {
								inbox: 5,
								inbox_unread: 3,
								primary_count: 3,
								primary_unread: 2,
								social: 2,
								social_unread: 1,
								promotions: 0,
								promotions_unread: 0,
								updates: 0,
								updates_unread: 0,
								forums: 0,
								forums_unread: 0,
								archive: 0,
								starred: 0,
								drafts: 0,
								sent: 0,
								trash: 0,
								spam: 4
							};
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	const counts = await getMailboxCounts(db, 'user-1');
	assert.equal(counts.primary_unread, 2);
	assert.equal(counts.social_unread, 1);
	assert.equal(counts.inbox_unread, 3);
	assert.equal(counts.spam, 4);
	assert.match(sql, /spam_at IS NULL/);
	assert.match(sql, /spam_at IS NOT NULL/);
	assert.match(sql, /category = 'primary'/);
	assert.match(sql, /category = 'social'/);
	assert.match(
		sql,
		/spam_at IS NULL AND direction = 'inbound' AND category = 'primary'/
	);
	assert.match(sql, /deleted_at IS NULL AND spam_at IS NOT NULL THEN/);
});

test('unclassified inbound mail is live inbound with no category or spam source', async () => {
	let countSql = '';
	let listSql = '';
	const binds: unknown[][] = [];
	const db = {
		prepare(query: string) {
			if (query.includes('COUNT(*)')) {
				countSql = query;
				return {
					bind(...values: unknown[]) {
						binds.push(values);
						return {
							async first() {
								return { n: 3 };
							}
						};
					}
				};
			}
			listSql = query;
			return {
				bind(...values: unknown[]) {
					binds.push(values);
					return {
						async all() {
							return { results: [] };
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	assert.equal(await countUnclassifiedInbound(db, 'user-1'), 3);
	await listUnclassifiedInbound(db, 'user-1', {
		after: { createdAt: '2026-01-01 00:00:00', id: 'msg-1' },
		limit: 1
	});
	assert.match(countSql, /COUNT\(\*\)/);
	assert.match(countSql, /category_source IS NULL/);
	assert.match(countSql, /spam_source IS NULL/);
	assert.match(countSql, /direction = 'inbound'/);
	assert.match(listSql, /created_at > \? OR \(created_at = \? AND id > \?\)/);
	assert.match(listSql, /LIMIT \?/);
	assert.match(UNCLASSIFIED_INBOUND_WHERE, /status <> 'draft'/);
	assert.deepEqual(binds, [
		['user-1'],
		['user-1', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'msg-1', 1]
	]);
});

test('markAllRead scopes to a label without rewriting the rest of the mailbox', async () => {
	let sql = '';
	let binds: unknown[] = [];
	const db = {
		prepare(query: string) {
			sql = query;
			return {
				bind(...values: unknown[]) {
					binds = values;
					return {
						async all() {
							return { results: [{ id: 'one' }, { id: 'two' }] };
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	assert.equal(await markAllRead(db, 'user-1', 'domain-1', 'primary', 'label-9'), 2);
	assert.match(sql, /EXISTS \(SELECT 1 FROM email_labels el WHERE el.email_id = emails.id AND el.label_id = \?\)/);
	assert.doesNotMatch(sql, /direction = 'inbound'/);
	assert.doesNotMatch(sql, /category = \?/);
	assert.deepEqual(binds, ['user-1', 'label-9', 'domain-1']);
});

function storedMailFixture() {
	const { db, sqlite } = createTestDb();
	insertTestUser(sqlite);
	insertTestUser(sqlite, 'user-2');
	const objects = new Set<string>();
	const deleted: string[] = [];
	const state = { failRawDelete: false };
	for (const [id, userId, rawKey] of [
		['owned', 'user-1', 'raw-messages/owned.eml'],
		['other', 'user-2', 'raw-messages/other.eml'],
		['historic', 'user-1', null]
	] as const) {
		sqlite.query(`INSERT INTO emails
			(id, user_id, direction, from_addr, to_addr, subject, raw_storage_key)
			VALUES (?, ?, 'inbound', 'sender@example.net', 'inbox@example.com', 'Mail', ?)`)
			.run(id, userId, rawKey);
		sqlite.query(`INSERT INTO email_attachments
			(id, email_id, filename, content_type, size_bytes, content_base64, storage_key)
			VALUES (?, ?, 'file.txt', 'text/plain', 4, '', ?)`)
			.run(`attachment-${id}`, id, `attachments/${id}`);
		objects.add(`attachments/${id}`);
		if (rawKey) objects.add(rawKey);
	}
	const bucket = {
		async delete(key: string) {
			if (state.failRawDelete && key.startsWith('raw-messages/')) {
				throw new Error('Original deletion unavailable');
			}
			deleted.push(key);
			objects.delete(key);
		}
	} as unknown as R2Bucket;
	return { db, sqlite, bucket, objects, deleted, state };
}

describe('permanent mail deletion with originals', () => {
	test('deletes only owned mail and its attachments/original in a mixed-user request', async () => {
		const f = storedMailFixture();
		assert.equal(await deleteEmailsPermanently(f.db, f.bucket, 'user-1', ['owned', 'other', 'missing']), 1);
		assert.deepEqual(f.deleted.sort(), ['attachments/owned', 'raw-messages/owned.eml']);
		assert.deepEqual(
			f.sqlite.query('SELECT id FROM emails ORDER BY id').all(),
			[{ id: 'historic' }, { id: 'other' }]
		);
		assert.deepEqual(
			f.sqlite.query('SELECT email_id FROM email_attachments ORDER BY email_id').all(),
			[{ email_id: 'historic' }, { email_id: 'other' }]
		);
		assert.equal(f.objects.has('raw-messages/other.eml'), true);
		assert.equal(f.objects.has('attachments/other'), true);
	});

	test('makes no storage changes when all requested messages belong to another user', async () => {
		const f = storedMailFixture();
		assert.equal(await deleteEmailsPermanently(f.db, f.bucket, 'user-1', ['other']), 0);
		assert.deepEqual(f.deleted, []);
		assert.equal(f.sqlite.query('SELECT id FROM emails').all().length, 3);
	});

	test('deletes historic mail without trying to delete a null original key', async () => {
		const f = storedMailFixture();
		assert.equal(await deleteEmailsPermanently(f.db, f.bucket, 'user-1', ['historic']), 1);
		assert.deepEqual(f.deleted, ['attachments/historic']);
		assert.equal(f.objects.has('raw-messages/owned.eml'), true);
	});

	test('queues failed storage deletion durably after atomic mail removal and retries it', async () => {
		const f = storedMailFixture();
		f.state.failRawDelete = true;
		assert.equal(await deleteEmailsPermanently(f.db, f.bucket, 'user-1', ['owned']), 1);
		assert.deepEqual(f.sqlite.query("SELECT id FROM emails WHERE id = 'owned'").all(), []);
		assert.deepEqual(f.sqlite.query('SELECT storage_key FROM mail_storage_cleanup').all(), [
			{ storage_key: 'raw-messages/owned.eml' }
		]);
		f.state.failRawDelete = false;
		assert.deepEqual(await drainMailStorageCleanup(f.db, f.bucket), { deleted: 1, failed: 0 });
		assert.equal(f.sqlite.query('SELECT COUNT(*) AS n FROM mail_storage_cleanup').all()[0].n, 0);
		assert.equal(f.objects.has('raw-messages/owned.eml'), false);
		assert.equal(f.objects.has('raw-messages/other.eml'), true);
	});
});
