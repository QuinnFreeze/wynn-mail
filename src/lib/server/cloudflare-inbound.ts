import type { R2Bucket } from '@cloudflare/workers-types';
import PostalMime, { type Address, type Attachment } from 'postal-mime';
import { insertAttachmentBytes } from './attachments';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_EMAIL } from './constants';
import { recordUnroutedEmail, resolveInboundRoute } from './domains';
import { collectInboundRecipients, parseEmailAddress } from './email-address';
import { stripHtml } from './html';
import { inboundAttachmentMetadata } from './inbound';
import { insertEmail } from './mail-store';
import type { PushNotificationEnv } from './push-notifications';
import { scheduleInboundClassification } from './classify';
import { normalizeMessageId } from './send-mail';
import {
	scheduleTelegramNotification,
	type StoredAttachment,
	type TelegramNotificationEnv
} from './telegram-notify';

export type CloudflareInboundMessage = {
	readonly from: string;
	readonly to: string;
	readonly headers: Headers;
	readonly raw: ReadableStream<Uint8Array>;
	setReject(reason: string): void;
};

export type CloudflareInboundEnv = PushNotificationEnv &
	TelegramNotificationEnv & {
		ATTACHMENTS: R2Bucket;
		TYPESAFE_API_KEY?: string;
	};

export const MAX_RAW_EMAIL_BYTES = 5 * 1024 * 1024;

/** Bound the stream before buffering or parsing MIME, including missing size headers. */
async function readRawEmail(
	stream: ReadableStream<Uint8Array>
): Promise<Uint8Array<ArrayBuffer> | null> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RAW_EMAIL_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Email Routing delivers the full MIME on `message.raw`. Parse once, then reuse
 * the same mailbox routing and private attachment store as the Resend webhook path.
 */
export async function handleCloudflareInbound(
	message: CloudflareInboundMessage,
	env: CloudflareInboundEnv
): Promise<void> {
	const raw = await readRawEmail(message.raw);
	if (!raw) {
		message.setReject('Message exceeds the 5 MiB mailbox size limit');
		return;
	}
	const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });

	const envelopeTo = parseEmailAddress(message.to);
	const recipients = collectInboundRecipients({
		received_for: envelopeTo.includes('@') ? [envelopeTo] : [],
		to: mailboxAddresses(parsed.to),
		cc: mailboxAddresses(parsed.cc),
		bcc: mailboxAddresses(parsed.bcc)
	});

	const sender = firstMailboxIdentity(parsed.from);
	const from = inboundSender(sender?.address, message.from);
	const subject = parsed.subject?.trim() || message.headers.get('subject')?.trim() || '(no subject)';
	const messageId =
		normalizeMessageId(parsed.messageId ?? message.headers.get('message-id')) ?? null;
	const inReplyTo =
		normalizeMessageId(parsed.inReplyTo ?? message.headers.get('in-reply-to')) ?? null;
	const references = parsed.references ?? message.headers.get('references') ?? null;
	const providerId = messageId ?? `cf-${await sha256(raw)}`;

	const route = await resolveInboundRoute(env.DB, recipients);

	if (!route) {
		const recorded = await recordUnroutedEmail(env.DB, {
			providerId,
			from,
			to: recipients.join(', ') || envelopeTo || '(unknown)',
			subject,
			reason: 'No matching address and no catch-all for this domain'
		});
		if (recorded) {
			scheduleTelegramNotification(env, {
				from,
				to: recipients.join(', ') || envelopeTo || '(unknown)',
				subject,
				body: parsed.text ?? (parsed.html ? stripHtml(parsed.html) : null),
				unrouted: true
			});
		}
		return;
	}

	const existing = await env.DB
		.prepare(
			`SELECT id, raw_storage_key FROM emails
			 WHERE provider_id = ? AND user_id = ? AND direction = 'inbound' LIMIT 1`
		)
		.bind(providerId, route.userId)
		.first<{ id: string; raw_storage_key: string | null }>();

	// Persist the original before inserting the parsed message. A stable key
	// lets a retry recover it even if the D1 insert or association was interrupted.
	// Never overwrite an already archived original with a later delivery's MIME.
	const rawStorageKey = existing?.raw_storage_key ??
		`raw-messages/${await sha256(new TextEncoder().encode(`${route.userId}\n${providerId}`))}.eml`;
	if (!(await env.ATTACHMENTS.get(rawStorageKey))) {
		await env.ATTACHMENTS.put(rawStorageKey, raw, {
			httpMetadata: { contentType: 'message/rfc822' },
			customMetadata: { filename: 'message.eml' }
		});
	}

	if (existing) {
		await linkRawMessage(env, existing.id, route.userId, rawStorageKey);
		return;
	}

	const emailId = await insertEmail(env.DB, {
		userId: route.userId,
		direction: 'inbound',
		from,
		fromName: sender?.name,
		to: route.address,
		cc: mailboxAddresses(parsed.cc).join(', ') || null,
		subject,
		bodyText: parsed.text ?? null,
		bodyHtml: parsed.html ?? null,
		messageId,
		inReplyTo,
		references,
		domainId: route.domainId,
		addressId: route.addressId,
		providerId
	});
	await linkRawMessage(env, emailId, route.userId, rawStorageKey);

	const storedAttachments = await storeInboundAttachments(env, emailId, parsed.attachments);
	scheduleInboundClassification(env, {
		emailId,
		userId: route.userId,
		from,
		fromName: sender?.name,
		to: route.address,
		subject,
		bodyText: parsed.text ?? null,
		attachmentNames: storedAttachments.map((attachment) => attachment.filename),
		telegram: {
			from: sender?.name ? `${sender.name} <${from}>` : from,
			to: route.address,
			subject,
			body: parsed.text ?? (parsed.html ? stripHtml(parsed.html) : null),
			attachments: storedAttachments
		}
	});
}

/** Returns the attachments that actually made it into storage. */
export async function storeInboundAttachments(
	env: CloudflareInboundEnv,
	emailId: string,
	attachments: Attachment[]
): Promise<StoredAttachment[]> {
	const stored: StoredAttachment[] = [];

	for (const attachment of attachments.slice(0, MAX_ATTACHMENTS_PER_EMAIL)) {
		const bytes = attachmentBytes(attachment.content);
		if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
			continue;
		}

		try {
			const metadata = inboundAttachmentMetadata({
				disposition: attachment.disposition,
				contentId: attachment.contentId,
				related: attachment.related
			});
			await insertAttachmentBytes(env.DB, env.ATTACHMENTS, emailId, {
				filename: attachment.filename || 'attachment',
				type: attachment.mimeType || 'application/octet-stream',
				bytes,
				...metadata
			});
			stored.push({
				filename: attachment.filename || 'attachment',
				sizeBytes: bytes.byteLength,
				contentType: attachment.mimeType || 'application/octet-stream',
				bytes
			});
		} catch (error) {
			console.error('Failed to store inbound Cloudflare attachment', attachment.filename, error);
		}
	}

	return stored;
}

/**
 * Who the mail is *from*, for display, replies and search.
 *
 * `message.from` is the envelope sender — SMTP `MAIL FROM` — which providers
 * routinely point at a bounce mailbox rather than the author. Cloudflare Email
 * Sending uses `bounces@cf-bounce.<domain>`, and VERP senders behave the same
 * way, so preferring the envelope attributes mail to the bounce address and
 * sends replies there. The `From:` header carries the author, so it wins; the
 * envelope is only a fallback for mail that arrives without a usable header.
 */
export function inboundSender(
	headerFrom: string | undefined,
	envelopeFrom: string | undefined
): string {
	// Choose on whether the header actually yielded an address, not on whether it
	// was present: a blank or malformed `From:` is still a truthy string, and
	// picking it on that alone would skip the fallback entirely.
	const header = parseEmailAddress(headerFrom ?? '');
	if (header.includes('@')) return header;

	const envelope = parseEmailAddress(envelopeFrom ?? '');
	return envelope || header;
}

function mailboxAddresses(value: Address | Address[] | undefined): string[] {
	if (!value) return [];
	const list = Array.isArray(value) ? value : [value];
	const addresses: string[] = [];

	for (const item of list) {
		if (item.address) addresses.push(item.address);
		if (item.group) {
			for (const member of item.group) {
				if (member.address) addresses.push(member.address);
			}
		}
	}

	return addresses;
}

function firstMailboxIdentity(
	value: Address | Address[] | undefined
): { name: string | null; address: string } | null {
	if (!value) return null;
	const list = Array.isArray(value) ? value : [value];

	for (const item of list) {
		if (item.address) return { name: item.name?.trim() || null, address: parseEmailAddress(item.address) };
		if (item.group) {
			for (const member of item.group) {
				if (member.address) {
					return {
						name: member.name?.trim() || null,
						address: parseEmailAddress(member.address)
					};
				}
			}
		}
	}

	return null;
}

function attachmentBytes(content: Attachment['content']): Uint8Array | null {
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	if (ArrayBuffer.isView(content)) {
		return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	}
	if (typeof content === 'string' && content.length > 0) {
		return new TextEncoder().encode(content);
	}
	return null;
}

async function linkRawMessage(
	env: CloudflareInboundEnv,
	emailId: string,
	userId: string,
	storageKey: string
): Promise<void> {
	const result = await env.DB
		.prepare('UPDATE emails SET raw_storage_key = ? WHERE id = ? AND user_id = ?')
		.bind(storageKey, emailId, userId)
		.run();
	if (!result.success || result.meta.changes !== 1) {
		throw new Error('Failed to associate the original message with its mailbox');
	}
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
