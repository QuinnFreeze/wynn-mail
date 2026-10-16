import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { Attachment } from 'postal-mime';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_EMAIL } from './constants';
import {
	handleCloudflareInbound,
	inboundSender,
	MAX_RAW_EMAIL_BYTES,
	storeInboundAttachments,
	type CloudflareInboundEnv,
	type CloudflareInboundMessage
} from './cloudflare-inbound';
import { createTestDb, insertTestUser } from './test-db';
import { deleteMailMatching, drainMailStorageCleanup } from './mail-deletion';
import { GET as downloadRaw } from '../../routes/api/emails/[id]/raw/+server';

describe('inboundSender', () => {
	test('prefers the From: header over the bounce envelope sender', () => {
		// Cloudflare Email Sending puts bounces@cf-bounce.<domain> in MAIL FROM, so
		// mail between two addresses on the same instance arrives with an envelope
		// sender that is not the author. Taking it would mis-attribute the message
		// and point replies at the bounce mailbox.
		assert.equal(
			inboundSender('alice@example.com', 'bounces@cf-bounce.example.com'),
			'alice@example.com'
		);
	});

	test('falls back to the envelope sender when there is no From: header', () => {
		assert.equal(inboundSender(undefined, 'someone@example.com'), 'someone@example.com');
		assert.equal(inboundSender('', 'someone@example.com'), 'someone@example.com');
	});

	test('falls back when the From: header yields no address', () => {
		// Blank and malformed headers are still truthy strings, so the choice has
		// to turn on whether an address came out of them.
		assert.equal(inboundSender('   ', 'someone@example.com'), 'someone@example.com');
		assert.equal(inboundSender('<>', 'someone@example.com'), 'someone@example.com');
		assert.equal(
			inboundSender('undisclosed-recipients', 'someone@example.com'),
			'someone@example.com'
		);
	});

	test('unwraps a display name', () => {
		assert.equal(inboundSender('Grace Hopper <grace@example.com>', ''), 'grace@example.com');
	});

	test('normalises case', () => {
		assert.equal(inboundSender('Grace@Example.COM', ''), 'grace@example.com');
	});

	test('returns an empty string when neither is present', () => {
		assert.equal(inboundSender(undefined, undefined), '');
	});
});

function mockEnv(options: { failPut?: boolean } = {}) {
	const bucket = {
		async put() {
			if (options.failPut) throw new Error('R2 unavailable');
		}
	} as unknown as R2Bucket;

	const db = {
		prepare() {
			return {
				bind() {
					return { async run() {} };
				}
			};
		}
	} as unknown as D1Database;

	return { DB: db, ATTACHMENTS: bucket };
}

function parsed(count: number, byteLength = 10): Attachment[] {
	return Array.from({ length: count }, (_, i) => ({
		filename: `file-${i}.txt`,
		mimeType: 'text/plain',
		disposition: 'attachment',
		content: new ArrayBuffer(byteLength)
	})) as unknown as Attachment[];
}

describe('storeInboundAttachments (Cloudflare)', () => {
	test('returns what was stored', async () => {
		assert.equal((await storeInboundAttachments(mockEnv(), 'email-1', parsed(3))).length, 3);
	});

	test('does not include empty or oversized parts', async () => {
		// The count is what the reader can actually open, so parts we drop must
		// not appear in the notification.
		assert.equal((await storeInboundAttachments(mockEnv(), 'email-1', parsed(1, 0))).length, 0);
		assert.equal((await storeInboundAttachments(mockEnv(), 'email-1', parsed(1, MAX_ATTACHMENT_BYTES + 1))).length, 0);
	});

	test('does not include an attachment whose storage fails', async () => {
		assert.equal((await storeInboundAttachments(mockEnv({ failPut: true }), 'email-1', parsed(2))).length, 0);
	});

	test('stores no more than the per-message cap', async () => {
		assert.equal((await storeInboundAttachments(mockEnv(), 'email-1', parsed(MAX_ATTACHMENTS_PER_EMAIL + 3))).length, MAX_ATTACHMENTS_PER_EMAIL);
	});

	test('handles a message with no attachments', async () => {
		assert.equal((await storeInboundAttachments(mockEnv(), 'email-1', [])).length, 0);
	});
});

type RawEmailRow = { id: string; user_id: string; raw_storage_key: string | null };

function archiveFixture() {
	const { db, sqlite } = createTestDb();
	insertTestUser(sqlite);
	insertTestUser(sqlite, 'user-2');
	sqlite.query(`INSERT INTO domains (id, name, status) VALUES ('domain-1', 'example.com', 'verified')`).run();
	sqlite.query(`INSERT INTO addresses (id, user_id, domain_id, address)
		VALUES ('address-1', 'user-1', 'domain-1', 'inbox@example.com')`).run();
	const objects = new Map<string, Uint8Array>();
	const reads: string[] = [];
	const state = { failGet: false, failPut: false, failPutResponse: false, puts: 0 };
	const bucket = {
		async get(key: string) {
			reads.push(key);
			if (state.failGet) throw new Error('Storage read unavailable');
			const bytes = objects.get(key);
			return bytes ? {
				key,
				size: bytes.byteLength,
				body: new Response(new Uint8Array(bytes)).body,
				async arrayBuffer() { return new Uint8Array(bytes).buffer; }
			} : null;
		},
		async put(key: string, value: Uint8Array | ArrayBuffer) {
			if (state.failPut) throw new Error('Storage write unavailable');
			state.puts++;
			objects.set(key, new Uint8Array(value).slice());
			if (state.failPutResponse) throw new Error('Storage write response interrupted');
			return { key };
		},
		async delete(key: string) {
			objects.delete(key);
		}
	} as unknown as R2Bucket;
	const pending: Promise<void>[] = [];
	const env: CloudflareInboundEnv = {
		DB: db,
		ATTACHMENTS: bucket,
		waitUntil(task) { pending.push(task); }
	};
	const rejected: string[] = [];
	async function deliver(bytes: Uint8Array, overrideEnv = env) {
		const message: CloudflareInboundMessage = {
			from: 'bounce@example.net',
			to: 'inbox@example.com',
			headers: new Headers(),
			raw: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
			setReject(reason) { rejected.push(reason); }
		};
		await handleCloudflareInbound(message, overrideEnv);
		await Promise.all(pending.splice(0));
	}
	function emails(): RawEmailRow[] {
		return sqlite.query('SELECT id, user_id, raw_storage_key FROM emails').all() as RawEmailRow[];
	}
	async function download(emailId: string, userId: string | null = 'user-1') {
		return downloadRaw({
			params: { id: emailId },
			locals: { user: userId ? { id: userId } : null },
			platform: { env: { DB: db, ATTACHMENTS: bucket } }
		} as unknown as Parameters<typeof downloadRaw>[0]);
	}
	return { db, sqlite, env, objects, reads, state, rejected, deliver, emails, download };
}

function rawMime(options: { messageId?: string | null; body?: Uint8Array } = {}): Uint8Array {
	const messageId = options.messageId === undefined ? 'original-1@example.net' : options.messageId;
	const headers = new TextEncoder().encode([
		'From: Sender <sender@example.net>',
		'To: inbox@example.com',
		'Subject: Original message',
		'Date: Thu, 15 Oct 2026 10:00:00 +0000',
		...(messageId ? [`Message-ID: <${messageId}>`] : []),
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=iso-8859-1',
		'Content-Transfer-Encoding: 8bit',
		'',
		''
	].join('\r\n'));
	// Non-UTF8 bytes, NUL and CRLF catch accidental decoding/re-encoding.
	const body = options.body ?? new Uint8Array([0x48, 0xe9, 0x00, 0x0d, 0x0a, 0xff]);
	const bytes = new Uint8Array(headers.length + body.length);
	bytes.set(headers);
	bytes.set(body, headers.length);
	return bytes;
}

/** Fail before or after a real SQLite statement; the remaining SQL stays real. */
function failOnce(
	db: D1Database,
	match: (sql: string) => boolean,
	afterCommit = false
): D1Database {
	let failed = false;
	return {
		prepare(sql: string) {
			const statement = db.prepare(sql);
			const wrapped = {
				bind(...values: unknown[]) { statement.bind(...values); return wrapped; },
				first: (column?: string) => column === undefined ? statement.first() : statement.first(column),
				all: () => statement.all(),
				async run() {
					if (!failed && match(sql)) {
						failed = true;
						if (afterCommit) await statement.run();
						throw new Error('D1 interrupted');
					}
					return statement.run();
				}
			};
			return wrapped;
		},
		batch: db.batch.bind(db)
	} as unknown as D1Database;
}

describe('Cloudflare original message archive', () => {
	test('stores and downloads every original byte with safe download headers', async () => {
		const f = archiveFixture();
		const raw = rawMime();
		await f.deliver(raw);
		const [email] = f.emails();
		assert.equal(email.user_id, 'user-1');
		assert.match(email.raw_storage_key!, /^raw-messages\/[a-f0-9-]{36}\.eml$/);
		assert.deepEqual(f.objects.get(email.raw_storage_key!), raw);
		const response = await f.download(email.id);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('Content-Type'), 'message/rfc822');
		assert.equal(response.headers.get('Content-Disposition'), `attachment; filename="${email.id}.eml"`);
		assert.equal(response.headers.get('Cache-Control'), 'no-store');
		assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
		assert.equal(response.headers.get('Content-Length'), String(raw.byteLength));
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), raw);
	});

	test('denies another owner and unauthenticated callers before reading storage', async () => {
		const f = archiveFixture();
		await f.deliver(rawMime());
		const [email] = f.emails();
		f.reads.length = 0;
		await assert.rejects(f.download(email.id, 'user-2'), { status: 404 });
		await assert.rejects(f.download('missing'), { status: 404 });
		await assert.rejects(f.download(email.id, null), { status: 401 });
		assert.deepEqual(f.reads, []);
	});

	test('returns 404 for an unavailable original, including historic mail', async () => {
		const f = archiveFixture();
		await f.deliver(rawMime());
		const [email] = f.emails();
		f.objects.clear();
		await assert.rejects(f.download(email.id), { status: 404 });
		f.sqlite.query('UPDATE emails SET raw_storage_key = NULL WHERE id = ?').run(email.id);
		await assert.rejects(f.download(email.id), { status: 404 });
	});

	test('propagates storage failure, writes no parsed email, and recovers on retry', async () => {
		const f = archiveFixture();
		const raw = rawMime();
		f.state.failPut = true;
		await assert.rejects(f.deliver(raw), /Storage write unavailable/);
		assert.equal(f.emails().length, 0);
		f.state.failPut = false;
		await f.deliver(raw);
		assert.equal(f.emails().length, 1);
		assert.deepEqual(f.objects.get(f.emails()[0].raw_storage_key!), raw);
	});

	test('queues an unlinked original when insertion fails and retries with a fresh generation', async () => {
		const f = archiveFixture();
		const raw = rawMime();
		const interrupted = failOnce(f.db, (sql) => /INSERT INTO emails\s*\(/.test(sql));
		await assert.rejects(f.deliver(raw, { ...f.env, DB: interrupted }), /D1 interrupted/);
		assert.equal(f.emails().length, 0);
		assert.equal(f.objects.size, 1);
		const [key] = f.objects.keys();
		assert.deepEqual(f.sqlite.query('SELECT storage_key FROM mail_storage_cleanup').all(), [{ storage_key: key }]);
		await f.deliver(raw);
		const currentKey = f.emails()[0].raw_storage_key!;
		assert.notEqual(currentKey, key);
		assert.equal(f.state.puts, 2);
		assert.deepEqual(await drainMailStorageCleanup(f.db, f.env.ATTACHMENTS), { deleted: 1, failed: 0 });
		assert.equal(f.objects.has(key), false);
		assert.deepEqual(f.objects.get(currentKey), raw);
	});

	test('keeps the atomic original association when the committed insert response is lost', async () => {
		const f = archiveFixture();
		const raw = rawMime();
		const interrupted = failOnce(f.db, (sql) => /INSERT INTO emails\s*\(/.test(sql), true);
		await assert.rejects(f.deliver(raw, { ...f.env, DB: interrupted }), /D1 interrupted/);
		assert.equal(f.emails().length, 1);
		const key = f.emails()[0].raw_storage_key!;
		assert.ok(key);
		assert.deepEqual(f.objects.get(key), raw);
		assert.deepEqual(await drainMailStorageCleanup(f.db, f.env.ATTACHMENTS), { deleted: 0, failed: 0 });
		await f.deliver(raw);
		assert.equal(f.emails()[0].raw_storage_key, key);
		assert.equal(f.state.puts, 1);
	});

	for (const afterCommit of [false, true]) {
		test(`repairs a historic original association failure ${afterCommit ? 'after' : 'before'} commit`, async () => {
			const f = archiveFixture();
			const raw = rawMime();
			await f.deliver(raw);
			const emailId = f.emails()[0].id;
			f.objects.clear();
			f.sqlite.query('UPDATE emails SET raw_storage_key = NULL WHERE id = ?').run(emailId);
			const interrupted = failOnce(f.db, (sql) => sql.startsWith('UPDATE emails SET raw_storage_key'), afterCommit);
			await assert.rejects(f.deliver(raw, { ...f.env, DB: interrupted }), /D1 interrupted/);
			assert.equal(f.emails().length, 1);
			assert.equal(f.emails()[0].raw_storage_key, afterCommit ? `raw-messages/${emailId}.eml` : null);
			assert.equal(f.objects.size, 0);
			await f.deliver(raw);
			assert.equal(f.emails().length, 1);
			assert.equal(f.emails()[0].raw_storage_key, `raw-messages/${emailId}.eml`);
			assert.deepEqual(f.objects.get(f.emails()[0].raw_storage_key!), raw);
			assert.equal(f.state.puts, 2);
		});
	}

	test('queues a write whose storage response was lost without accepting a parsed message', async () => {
		const f = archiveFixture();
		f.state.failPutResponse = true;
		await assert.rejects(f.deliver(rawMime()), /Storage write response interrupted/);
		assert.equal(f.emails().length, 0);
		assert.equal(f.objects.size, 1);
		assert.deepEqual(await drainMailStorageCleanup(f.db, f.env.ATTACHMENTS), { deleted: 1, failed: 0 });
		assert.equal(f.objects.size, 0);
		f.state.failPutResponse = false;
		await f.deliver(rawMime());
		assert.equal(f.emails().length, 1);
	});

	test('preserves a preexisting legacy storage key and its original bytes', async () => {
		const f = archiveFixture();
		const raw = rawMime();
		await f.deliver(raw);
		const legacyKey = `raw-messages/${'a'.repeat(64)}.eml`;
		f.objects.clear();
		f.objects.set(legacyKey, raw);
		f.sqlite.query('UPDATE emails SET raw_storage_key = ? WHERE id = ?').run(legacyKey, f.emails()[0].id);
		await f.deliver(rawMime({ body: new TextEncoder().encode('Later delivery') }));
		assert.equal(f.emails()[0].raw_storage_key, legacyKey);
		assert.deepEqual(f.objects.get(legacyKey), raw);
		assert.equal(f.state.puts, 1);
	});

	test('redelivery during an awaited old-object deletion keeps the new generation downloadable', async () => {
		const f = archiveFixture();
		await f.deliver(rawMime());
		const previous = f.emails()[0];
		await deleteMailMatching(f.db, undefined, { where: 'e.id = ?', bindings: [previous.id] });
		let started!: () => void;
		let finish!: () => void;
		const deleting = new Promise<void>((resolve) => { started = resolve; });
		const gcBucket = {
			async delete(key: string) {
				started();
				await new Promise<void>((resolve) => { finish = resolve; });
				await f.env.ATTACHMENTS.delete(key);
			}
		} as unknown as R2Bucket;
		const cleanup = drainMailStorageCleanup(f.db, gcBucket, 1);
		await deleting;
		const replacement = rawMime({ body: new TextEncoder().encode('New delivery generation') });
		await f.deliver(replacement);
		const current = f.emails()[0];
		assert.notEqual(current.id, previous.id);
		assert.notEqual(current.raw_storage_key, previous.raw_storage_key);
		finish();
		assert.deepEqual(await cleanup, { deleted: 1, failed: 0 });
		assert.equal(f.objects.has(previous.raw_storage_key!), false);
		const downloaded = await f.download(current.id);
		assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), replacement);
	});

	test('requeues a historic original written after its row and first GC attempt were removed', async () => {
		const f = archiveFixture();
		const raw = rawMime();
		await f.deliver(raw);
		const emailId = f.emails()[0].id;
		f.objects.clear();
		f.sqlite.query('UPDATE emails SET raw_storage_key = NULL WHERE id = ?').run(emailId);
		const racingBucket = {
			get: f.env.ATTACHMENTS.get.bind(f.env.ATTACHMENTS),
			async put(key: string, value: Uint8Array) {
				await deleteMailMatching(f.db, undefined, { where: 'e.id = ?', bindings: [emailId] });
				await drainMailStorageCleanup(f.db, f.env.ATTACHMENTS);
				return f.env.ATTACHMENTS.put(key, value);
			}
		} as unknown as R2Bucket;
		await assert.rejects(f.deliver(raw, { ...f.env, ATTACHMENTS: racingBucket }), /removed while archiving/);
		assert.equal(f.emails().length, 0);
		assert.deepEqual([...f.objects.keys()], [`raw-messages/${emailId}.eml`]);
		assert.deepEqual(await drainMailStorageCleanup(f.db, f.env.ATTACHMENTS), { deleted: 1, failed: 0 });
		assert.equal(f.objects.size, 0);
	});

	test('keeps a late-write cleanup claim when an older object-delete response finishes later', async () => {
		const f = archiveFixture();
		const raw = rawMime();
		await f.deliver(raw);
		const emailId = f.emails()[0].id;
		f.objects.clear();
		f.sqlite.query('UPDATE emails SET raw_storage_key = NULL WHERE id = ?').run(emailId);
		let started!: () => void;
		let finish!: () => void;
		const deletionStarted = new Promise<void>((resolve) => { started = resolve; });
		let oldCleanup: Promise<{ deleted: number; failed: number }> | undefined;
		let oldGeneration: string | undefined;
		const responseDelayedBucket = {
			async delete(key: string) {
				// The object is gone, but the caller has not received its response.
				f.objects.delete(key);
				started();
				await new Promise<void>((resolve) => { finish = resolve; });
			}
		} as unknown as R2Bucket;
		const racingBucket = {
			get: f.env.ATTACHMENTS.get.bind(f.env.ATTACHMENTS),
			async put(key: string, value: Uint8Array) {
				await deleteMailMatching(f.db, undefined, { where: 'e.id = ?', bindings: [emailId] });
				oldGeneration = String(f.sqlite.query('SELECT generation FROM mail_storage_cleanup').all()[0].generation);
				oldCleanup = drainMailStorageCleanup(f.db, responseDelayedBucket);
				await deletionStarted;
				return f.env.ATTACHMENTS.put(key, value);
			}
		} as unknown as R2Bucket;
		await assert.rejects(f.deliver(raw, { ...f.env, ATTACHMENTS: racingBucket }), /removed while archiving/);
		const requeued = f.sqlite.query('SELECT generation FROM mail_storage_cleanup').all()[0];
		assert.match(oldGeneration ?? '', /^[a-f0-9]{32}$/);
		assert.match(String(requeued.generation), /^[a-f0-9]{32}$/);
		assert.notEqual(requeued.generation, oldGeneration);
		finish();
		await oldCleanup;
		assert.equal(f.objects.size, 1);
		assert.deepEqual(f.sqlite.query('SELECT storage_key FROM mail_storage_cleanup').all(),
			[{ storage_key: `raw-messages/${emailId}.eml` }]);
		assert.deepEqual(await drainMailStorageCleanup(f.db, f.env.ATTACHMENTS), { deleted: 1, failed: 0 });
		assert.equal(f.objects.size, 0);
	});

	test('preserves the first archived delivery and repairs missing objects on retry', async () => {
		const f = archiveFixture();
		const original = rawMime();
		await f.deliver(original);
		await f.deliver(rawMime({ body: new TextEncoder().encode('A later delivery') }));
		assert.equal(f.emails().length, 1);
		assert.equal(f.state.puts, 1);
		assert.deepEqual(f.objects.get(f.emails()[0].raw_storage_key!), original);
		f.objects.clear();
		f.state.failPut = true;
		await assert.rejects(f.deliver(original), /Storage write unavailable/);
		f.state.failPut = false;
		await f.deliver(original);
		assert.equal(f.emails().length, 1);
		assert.deepEqual(f.objects.get(f.emails()[0].raw_storage_key!), original);
	});

	test('distinguishes different MIME bodies without Message-ID', async () => {
		const f = archiveFixture();
		await f.deliver(rawMime({ messageId: null }));
		await f.deliver(rawMime({ messageId: null, body: new TextEncoder().encode('Another message') }));
		assert.equal(f.emails().length, 2);
		assert.equal(f.objects.size, 2);
	});

	test('rejects an oversized stream and cancels it before parsing or storing', async () => {
		const f = archiveFixture();
		let cancelled = false;
		const rejected: string[] = [];
		let chunks = 0;
		await handleCloudflareInbound({
			from: 'sender@example.net',
			to: 'inbox@example.com',
			headers: new Headers(),
			raw: new ReadableStream({
				pull(controller) {
					chunks++;
					controller.enqueue(new Uint8Array(MAX_RAW_EMAIL_BYTES / 5));
				},
				cancel() { cancelled = true; }
			}),
			setReject(reason) { rejected.push(reason); }
		}, f.env);
		assert.equal(cancelled, true);
		assert.match(rejected[0], /5 MiB/);
		assert.ok(chunks <= 7);
		assert.equal(f.emails().length, 0);
		assert.equal(f.objects.size, 0);
	});

	test('accepts a message exactly at the raw size limit', async () => {
		const f = archiveFixture();
		const headerSize = rawMime({ body: new Uint8Array() }).length;
		const raw = rawMime({ body: new Uint8Array(MAX_RAW_EMAIL_BYTES - headerSize).fill(0x61) });
		await f.deliver(raw);
		assert.equal(f.emails().length, 1);
		assert.equal(f.rejected.length, 0);
		assert.deepEqual(f.objects.get(f.emails()[0].raw_storage_key!), raw);
	});
});
