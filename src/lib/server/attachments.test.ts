import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { EmailRow } from '$lib/types';
import {
	base64ByteLength,
	base64ToBytes,
	bytesToBase64,
	getAttachmentForUser,
	insertAttachmentBytes,
	insertAttachments,
	listAttachments,
	normalizeContentId,
	readOutboundAttachments
} from './attachments';
import { readForwardedAttachments } from './forward-mail';
import { createTestDb, insertTestUser } from './test-db';
import { GET as downloadAttachment } from '../../routes/api/mail/[id]/attachments/[attachmentId]/+server';

describe('attachment encoding', () => {
	test('bytes survive the trip to base64 and back', () => {
		const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
		assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
	});

	test('a file larger than one chunk is not corrupted or truncated', () => {
		// 0x8000 is the chunk size, so this crosses the boundary several times.
		const bytes = new Uint8Array(0x8000 * 3 + 17);
		for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;

		const round = base64ToBytes(bytesToBase64(bytes));
		assert.equal(round.length, bytes.length);
		assert.deepEqual(round, bytes);
	});

	test('an empty part encodes to an empty string', () => {
		assert.equal(bytesToBase64(new Uint8Array(0)), '');
	});

	test('the reported size matches the bytes encoded, whatever the padding', () => {
		for (const length of [0, 1, 2, 3, 4, 5, 6, 100, 1023]) {
			const bytes = new Uint8Array(length).fill(7);
			assert.equal(base64ByteLength(bytesToBase64(bytes)), length);
		}
	});
});

test('forward-all attachments include every message, can be excluded, and stay user-scoped', async () => {
	const calls: Array<{ emailId: string; userId: string }> = [];
	const db = {
		prepare() {
			return {
				bind(emailId: string, userId: string) {
					calls.push({ emailId, userId });
					return {
						async all() {
							return {
								results: [
									{
										id: `file-${emailId}`,
										email_id: emailId,
										filename: `${emailId}.txt`,
										content_type: 'text/plain',
										size_bytes: 1,
										storage_key: null,
										content_base64: 'YQ==',
										created_at: '2026-01-01'
									}
								]
							};
						}
					};
				}
			};
		}
	} as unknown as D1Database;
	const bucket = {} as R2Bucket;
	const originals = [{ id: 'older' }, { id: 'newer' }] as EmailRow[];

	const included = await readForwardedAttachments(
		{ DB: db, ATTACHMENTS: bucket },
		'user-1',
		originals
	);
	assert.deepEqual(included.map((file) => file.filename), ['older.txt', 'newer.txt']);
	assert.deepEqual(calls, [
		{ emailId: 'older', userId: 'user-1' },
		{ emailId: 'newer', userId: 'user-1' }
	]);

	calls.length = 0;
	assert.deepEqual(
		await readForwardedAttachments(
			{ DB: db, ATTACHMENTS: bucket },
			'user-1',
			originals,
			false
		),
		[]
	);
	assert.deepEqual(calls, []);
});

test('insertAttachments persists inline disposition and normalized Content-ID', async () => {
	const statements: Array<{ sql: string; bindings: unknown[] }> = [];
	const db = {
		prepare(sql: string) {
			return {
				bind(...bindings: unknown[]) {
					statements.push({ sql, bindings });
					return { async run() {} };
				}
			};
		}
	} as unknown as D1Database;
	const bucket = { async put() {} } as unknown as R2Bucket;

	await insertAttachments(db, bucket, 'email-1', [
		{
			filename: 'logo.svg',
			type: 'image/svg+xml',
			content: 'PHN2ZyAvPg==',
			disposition: 'inline',
			contentId: ' <logo@example.test> '
		}
	]);

	assert.equal(statements.length, 1);
	assert.match(statements[0].sql, /content_disposition, content_id/);
	assert.equal(statements[0].bindings.at(-2), 'inline');
	assert.equal(statements[0].bindings.at(-1), 'logo@example.test');
});

test('insertAttachmentBytes keeps legacy metadata optional', async () => {
	const bindings: unknown[][] = [];
	const db = {
		prepare() {
			return {
				bind(...values: unknown[]) {
					bindings.push(values);
					return { async run() {} };
				}
			};
		}
	} as unknown as D1Database;
	const bucket = { async put() {} } as unknown as R2Bucket;

	await insertAttachmentBytes(db, bucket, 'email-1', {
		filename: 'notes.txt',
		type: 'text/plain',
		bytes: new TextEncoder().encode('a')
	});

	assert.equal(bindings[0].at(-2), null);
	assert.equal(bindings[0].at(-1), null);
});

test('inline SVG metadata survives storage and read-forward conversion while null rows work', async () => {
	const rows = [
		{
			id: 'svg-1',
			email_id: 'email-1',
			filename: 'logo.svg',
			content_type: 'image/svg+xml',
			size_bytes: 7,
			content_disposition: 'inline',
			content_id: '<logo@example.test>',
			storage_key: null,
			content_base64: 'PHN2ZyAvPg==',
			created_at: '2026-01-01'
		},
		{
			id: 'legacy-1',
			email_id: 'email-1',
			filename: 'notes.txt',
			content_type: 'text/plain',
			size_bytes: 1,
			content_disposition: null,
			content_id: null,
			storage_key: null,
			content_base64: 'YQ==',
			created_at: '2026-01-01'
		}
	];
	const db = {
		prepare() {
			return {
				bind() {
					return {
						async all() {
							return { results: rows };
						}
					};
				}
			};
		}
	} as unknown as D1Database;
	const bucket = {} as R2Bucket;

	assert.deepEqual(await readOutboundAttachments(db, bucket, 'user-1', 'email-1'), [
		{
			filename: 'logo.svg',
			type: 'image/svg+xml',
			content: 'PHN2ZyAvPg==',
			disposition: 'inline',
			contentId: 'logo@example.test'
		},
		{ filename: 'notes.txt', type: 'text/plain', content: 'YQ==' }
	]);
});

test('list and get attachment metadata normalize Content-ID values', async () => {
	const row = {
		id: 'file-1',
		email_id: 'email-1',
		filename: 'logo.svg',
		content_type: 'image/svg+xml',
		size_bytes: 7,
		content_disposition: 'inline',
		content_id: '<logo@example.test>',
		storage_key: 'email-1/file-1/logo.svg',
		content_base64: null,
		created_at: '2026-01-01'
	};
	const db = {
		prepare() {
			return {
				bind() {
					return {
						async all() {
							return { results: [row] };
						},
						async first() {
							return row;
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	assert.equal((await listAttachments(db, 'email-1'))[0].content_id, 'logo@example.test');
	assert.equal(
		(await getAttachmentForUser(db, 'user-1', 'email-1', 'file-1'))?.content_id,
		'logo@example.test'
	);
});

test('normalizing Content-ID is tolerant of legacy values and rejects line breaks', () => {
	assert.equal(normalizeContentId(' <logo@example.test> '), 'logo@example.test');
	assert.equal(normalizeContentId('logo@example.test'), 'logo@example.test');
	assert.equal(normalizeContentId('<II_123@Mail>'), 'ii_123@mail');
	assert.equal(normalizeContentId(null), null);
	assert.equal(normalizeContentId('  '), null);
	assert.equal(normalizeContentId('logo@example.test\r\nX-Injected: yes'), null);
});

describe('untrusted attachment responses', () => {
	const originalBytes = new TextEncoder().encode('<script>globalThis.attachmentExecuted = true</script>');

	function fixture(contentType: string) {
		const { db, sqlite } = createTestDb();
		insertTestUser(sqlite, 'attachment-owner');
		insertTestUser(sqlite, 'another-owner');
		sqlite.query(`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject)
			VALUES ('attachment-email', 'attachment-owner', 'inbound', 'sender@example.test',
			'owner@example.test', 'Synthetic attachment security check')`).run();
		sqlite.query(`INSERT INTO email_attachments
			(id, email_id, filename, content_type, size_bytes, content_base64, storage_key)
			VALUES ('untrusted-file', 'attachment-email', 'test payload', ?, ?, '', 'synthetic-file-key')`)
			.run(contentType, originalBytes.length);
		let storageReads = 0;
		const bucket = {
			async get(key: string) {
				assert.equal(key, 'synthetic-file-key');
				storageReads++;
				return { async arrayBuffer() { return originalBytes.slice().buffer; } };
			}
		} as unknown as R2Bucket;
		return {
			storageReads: () => storageReads,
			async get(userId = 'attachment-owner', download = false, emailId = 'attachment-email') {
				return downloadAttachment({
					params: { id: emailId, attachmentId: 'untrusted-file' },
					locals: { user: { id: userId } },
					platform: { env: { DB: db, ATTACHMENTS: bucket } },
					url: new URL(`https://mail.example.test/api/mail/${emailId}/attachments/untrusted-file${download ? '?download=1' : ''}`)
				} as unknown as Parameters<typeof downloadAttachment>[0]);
			}
		};
	}

	function assertIsolated(response: Response): void {
		const policy = response.headers.get('Content-Security-Policy') ?? '';
		assert.match(policy, /(?:^|;)\s*sandbox(?:;|$)/);
		assert.doesNotMatch(policy, /allow-scripts|allow-same-origin/);
		assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
		assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
		assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
	}

	test('active and unrecognized MIME attachments download without becoming same-origin pages', async () => {
		for (const type of [
			'text/html', 'TEXT/HTML; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml',
			'text/xml', 'application/xml', 'application/javascript', 'application/pdf', 'application/octet-stream'
		]) {
			const response = await fixture(type).get();
			assert.equal(response.status, 200);
			assert.match(response.headers.get('Content-Disposition') ?? '', /^attachment;/, type);
			assertIsolated(response);
			assert.deepEqual(new Uint8Array(await response.arrayBuffer()), originalBytes);
		}
	});

	test('raster images, plain text and JSON retain inline access with isolated unchanged bytes', async () => {
		for (const type of ['image/png', 'IMAGE/JPEG', 'image/webp', 'text/plain; charset=utf-8', 'application/json']) {
			const response = await fixture(type).get();
			assert.equal(response.status, 200);
			assert.match(response.headers.get('Content-Disposition') ?? '', /^inline;/, type);
			assertIsolated(response);
			assert.deepEqual(new Uint8Array(await response.arrayBuffer()), originalBytes);
		}
	});

	test('explicit download still downloads safe image and plain text attachments intact', async () => {
		for (const type of ['image/png', 'text/plain']) {
			const response = await fixture(type).get('attachment-owner', true);
			assert.match(response.headers.get('Content-Disposition') ?? '', /^attachment;/);
			assertIsolated(response);
			assert.deepEqual(new Uint8Array(await response.arrayBuffer()), originalBytes);
		}
	});

	test('attachment identity remains scoped to both the owning user and email before reading storage', async () => {
		const owned = fixture('text/html');
		await assert.rejects(owned.get('another-owner'), (error: unknown) => (error as { status?: number }).status === 404);
		await assert.rejects(owned.get('attachment-owner', false, 'another-email'), (error: unknown) => (error as { status?: number }).status === 404);
		assert.equal(owned.storageReads(), 0);
	});
});
