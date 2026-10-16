import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KVNamespace } from '@cloudflare/workers-types';
import { createKvAttachmentStore } from './kv-attachments';
import { createHybridProvider } from './providers/hybrid-provider';
import type { EmailProvider } from './email-provider';

test('KV storage preserves binary attachments, MIME metadata and deletions', async () => {
	const values = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
	const kv = {
		async put(key: string, bytes: Uint8Array, options: { metadata: unknown }) {
			values.set(key, { value: bytes.slice().buffer, metadata: options.metadata });
		},
		async getWithMetadata(key: string) {
			return values.get(key) ?? { value: null, metadata: null };
		},
		async delete(key: string) { values.delete(key); }
	} as unknown as KVNamespace;
	const storage = createKvAttachmentStore(kv);
	const original = new Uint8Array([0, 255, 13, 10, 128, 65]);
	await storage.put('private/mail.eml', original, { httpMetadata: { contentType: 'message/rfc822' } });
	const result = await storage.get('private/mail.eml');
	assert.ok(result);
	assert.deepEqual(new Uint8Array(await result.arrayBuffer()), original);
	const headers = new Headers();
	result.writeHttpMetadata(headers as unknown as Parameters<typeof result.writeHttpMetadata>[0]);
	assert.equal(headers.get('content-type'), 'message/rfc822');
	await storage.delete(['private/mail.eml']);
	assert.equal(await storage.get('private/mail.eml'), null);
	await assert.rejects(storage.put('oversized', new Uint8Array(5 * 1024 * 1024 + 1)), /exceeds/);
	assert.equal(values.size, 0);
});

test('Cloudflare receiving remains available before Resend sending is connected', async () => {
	const provider = createHybridProvider(null, ['mail.example.com']);
	const domain = await provider.getDomain('mail.example.com');
	assert.equal(domain.receivingEnabled, true);
	assert.equal(domain.sendingEnabled, false);
	assert.equal(domain.status, 'receiving-only');
	await assert.rejects(provider.getDomain('other.example.com'), /not configured/);
});

test('hybrid provider keeps stable domain IDs and never invents sending verification', async () => {
	const resend = {
		kind: 'resend',
		async listDomains() { return [
			{ id: 'resend-id', name: 'mail.example.com', status: 'pending', sendingEnabled: false, receivingEnabled: false },
			{ id: 'unrelated-id', name: 'unrelated.example.com', status: 'verified', sendingEnabled: true, receivingEnabled: true }
		]; }
	} as unknown as EmailProvider;
	const domains = await createHybridProvider(resend, ['mail.example.com']).listDomains();
	assert.equal(domains.length, 1);
	assert.equal(domains[0].id, 'mail.example.com');
	assert.equal(domains[0].receivingEnabled, true);
	assert.equal(domains[0].sendingEnabled, false);
});
