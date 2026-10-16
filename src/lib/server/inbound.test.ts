import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_EMAIL } from './constants';
import { storeInboundAttachments } from './inbound';
import type { ResendClient } from './resend';
import { createTestDb, insertTestUser } from './test-db';
import { POST as resendWebhook } from '../../routes/api/webhooks/resend/+server';

type ListedAttachment = {
	id: string;
	filename: string;
	content_type: string;
	size?: number;
	download_url?: string;
};

function mockEnv(options: { failPut?: boolean } = {}) {
	const stored: string[] = [];
	const bucket = {
		async put(key: string) {
			if (options.failPut) throw new Error('R2 unavailable');
			stored.push(key);
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

	return { env: { DB: db, ATTACHMENTS: bucket }, stored };
}

function mockClient(attachments: ListedAttachment[], bytesFor: (a: ListedAttachment) => number) {
	return {
		async listReceivedAttachments() {
			return attachments;
		},
		async downloadAttachment(url: string) {
			const match = attachments.find((a) => a.download_url === url)!;
			return new Uint8Array(bytesFor(match));
		}
	} as unknown as ResendClient;
}

function listed(count: number, size = 10): ListedAttachment[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `att-${i}`,
		filename: `file-${i}.txt`,
		content_type: 'text/plain',
		size,
		download_url: `https://resend.test/att-${i}`
	}));
}

describe('storeInboundAttachments (Resend)', () => {
	test('returns what was stored', async () => {
		const { env, stored } = mockEnv();
		const result = await storeInboundAttachments(env, mockClient(listed(3), () => 10), 'msg-1', 'email-1');
		assert.equal(result.length, 3);
		assert.equal(result.length, 3);
	});

	test('does not include an attachment the provider listed but never delivered', async () => {
		// No download_url — nothing to fetch, so nothing is stored, and announcing
		// it would promise the reader a file the mailbox does not have.
		const { env } = mockEnv();
		const attachments = [...listed(1), { id: 'att-x', filename: 'ghost.txt', content_type: 'text/plain' }];
		const result = await storeInboundAttachments(env, mockClient(attachments, () => 10), 'msg-1', 'email-1');
		assert.equal(result.length, 1);
	});

	test('does not include attachments skipped for size', async () => {
		const { env } = mockEnv();
		const big = listed(1, MAX_ATTACHMENT_BYTES + 1);
		const result = await storeInboundAttachments(env, mockClient(big, () => 10), 'msg-1', 'email-1');
		assert.equal(result.length, 0);
	});

	test('does not include an attachment whose body turns out to be oversized', async () => {
		// `size` from the listing is advisory; the downloaded body is the truth.
		const { env } = mockEnv();
		const attachments = listed(1, 10);
		const result = await storeInboundAttachments(
			env,
			mockClient(attachments, () => MAX_ATTACHMENT_BYTES + 1),
			'msg-1',
			'email-1'
		);
		assert.equal(result.length, 0);
	});

	test('does not include an attachment whose storage fails', async () => {
		const { env } = mockEnv({ failPut: true });
		const result = await storeInboundAttachments(env, mockClient(listed(2), () => 10), 'msg-1', 'email-1');
		assert.equal(result.length, 0);
	});

	test('stores no more than the per-message cap', async () => {
		const { env } = mockEnv();
		const result = await storeInboundAttachments(
			env,
			mockClient(listed(MAX_ATTACHMENTS_PER_EMAIL + 3), () => 10),
			'msg-1',
			'email-1'
		);
		assert.equal(result.length, MAX_ATTACHMENTS_PER_EMAIL);
	});

	test('returns nothing when the attachment listing fails', async () => {
		const { env } = mockEnv();
		const client = {
			async listReceivedAttachments() {
				throw new Error('Resend down');
			}
		} as unknown as ResendClient;
		assert.equal((await storeInboundAttachments(env, client, 'msg-1', 'email-1')).length, 0);
	});
});

const TEST_WEBHOOK_SECRET = `whsec_${btoa('test-only-webhook-signing-secret')}`;

async function signedWebhookRequest(event: unknown, eventId = crypto.randomUUID()): Promise<Request> {
	const body = JSON.stringify(event);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const key = await crypto.subtle.importKey(
		'raw', new TextEncoder().encode('test-only-webhook-signing-secret'),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
	);
	const digest = new Uint8Array(await crypto.subtle.sign(
		'HMAC', key, new TextEncoder().encode(`${eventId}.${timestamp}.${body}`)
	));
	const signature = btoa(String.fromCharCode(...digest));
	return new Request('https://mail.mailbox.test/api/webhooks/resend', {
		method: 'POST', body,
		headers: {
			'content-type': 'application/json', 'svix-id': eventId,
			'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}`
		}
	});
}

function webhookFixture() {
	const storage = createTestDb();
	insertTestUser(storage.sqlite, 'webhook-owner');
	storage.sqlite.query(`INSERT INTO emails
		(id, user_id, direction, from_addr, to_addr, subject, provider_id, status)
		VALUES ('own-email', 'webhook-owner', 'outbound', 'alice@mailbox.test',
		'recipient@external.test', 'Synthetic test', 'provider-own', 'sent')`).run();
	return storage;
}

async function runWebhook(
	request: Request,
	db: D1Database,
	overrides: Record<string, unknown> = {}
): Promise<Response> {
	return resendWebhook({
		request,
		platform: { env: {
			DB: db, ATTACHMENTS: {}, RESEND_API_KEY: 'test-only-api-key',
			RESEND_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
			INBOUND_EMAIL_PROVIDER: 'cloudflare', CLOUDFLARE_MAIL_DOMAINS: 'Mailbox.Test, receiving-only.test',
			RESEND_VERIFIED_SEND_DOMAINS: 'MAILBOX.TEST, static-only.test', ...overrides
		} }
	} as unknown as Parameters<typeof resendWebhook>[0]);
}

describe('Resend webhook scope with Cloudflare inbound and a static sending list', () => {
	test('validly signed out-of-scope events are acknowledged before any database access', async () => {
		const { db, sqlite } = webhookFixture();
		const before = sqlite.query('SELECT total_changes() AS changes').all()[0].changes;
		const statements: string[] = [];
		const noDatabaseAccess = {
			...db,
			prepare(sql: string) {
				statements.push(sql);
				throw new Error('An out-of-scope webhook reached the database');
			}
		} as unknown as D1Database;
		const events = [
			{ type: 'email.delivered', data: { from: 'Other <alice@foreign.test>' } },
			{ type: 'email.delivered', data: { from: '"alice@mailbox.test" <alice@foreign.test>' } },
			{ type: 'email.delivered', data: { from: 'alice@static-only.test' } },
			{ type: 'email.delivered', data: { from: 'alice@receiving-only.test' } },
			{ type: 'email.delivered', data: {} },
			{ type: 'email.delivered', data: { from: ['alice@mailbox.test'] } },
			{ type: 'email.delivered', data: { from: 'mailbox.test' } },
			{ type: 'email.received', data: { from: 'alice@mailbox.test' } },
			{ type: 'email.opened', data: { from: 'alice@mailbox.test' } }
		];
		for (const event of events) {
			const request = await signedWebhookRequest({
				...event, data: { email_id: 'provider-own', ...event.data }
			});
			const response = await runWebhook(request, noDatabaseAccess);
			assert.equal(response.status, 200);
			assert.equal(await response.text(), 'Event outside configured scope ignored');
		}
		assert.deepEqual(statements, []);
		assert.equal(sqlite.query('SELECT total_changes() AS changes').all()[0].changes, before);
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM webhook_events').all()[0].count, 0);
		assert.equal(sqlite.query("SELECT status FROM emails WHERE id = 'own-email'").all()[0].status, 'sent');
	});

	test('all six delivery events accept display names and case variations and update the stored email', async () => {
		const { db, sqlite } = webhookFixture();
		const statuses = {
			'email.sent': 'sent', 'email.delivered': 'delivered', 'email.delivery_delayed': 'delayed',
			'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed'
		};
		for (const [type, status] of Object.entries(statuses)) {
			sqlite.query("UPDATE emails SET status = 'sent', status_at = NULL WHERE id = 'own-email'").run();
			const eventId = crypto.randomUUID();
			const response = await runWebhook(await signedWebhookRequest({
				type, data: { email_id: 'provider-own', from: '"Wynn, Test" <WYNN@MAILBOX.TEST>' }
			}, eventId), db);
			assert.equal(response.status, 200);
			assert.equal((await response.json()).handled, true);
			const stored = sqlite.query("SELECT status, status_at FROM emails WHERE id = 'own-email'").all()[0];
			assert.equal(stored.status, status);
			assert.equal(typeof stored.status_at, 'string');
			assert.equal(sqlite.query('SELECT type FROM webhook_events WHERE id = ?').all(eventId)[0].type, type);
		}
	});

	test('an explicit empty list rejects delivery events without claiming them', async () => {
		const { db, sqlite } = webhookFixture();
		const response = await runWebhook(await signedWebhookRequest({
			type: 'email.delivered', data: { email_id: 'provider-own', from: 'alice@mailbox.test' }
		}), db, { RESEND_VERIFIED_SEND_DOMAINS: '' });
		assert.equal(response.status, 200);
		assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM webhook_events').all()[0].count, 0);
		assert.equal(sqlite.query("SELECT status FROM emails WHERE id = 'own-email'").all()[0].status, 'sent');
	});

	test('undefined sending list or non-Cloudflare inbound preserves existing delivery handling', async () => {
		for (const overrides of [
			{ RESEND_VERIFIED_SEND_DOMAINS: undefined },
			{ INBOUND_EMAIL_PROVIDER: 'resend' }
		]) {
			const { db, sqlite } = webhookFixture();
			// The legacy handler does not require From for delivery status updates.
			const response = await runWebhook(await signedWebhookRequest({
				type: 'email.delivered', data: { email_id: 'provider-own' }
			}), db, overrides);
			assert.equal(response.status, 200);
			assert.equal((await response.json()).handled, true);
			assert.equal(sqlite.query('SELECT COUNT(*) AS count FROM webhook_events').all()[0].count, 1);
			assert.equal(sqlite.query("SELECT status FROM emails WHERE id = 'own-email'").all()[0].status, 'delivered');
		}
	});
});
