import { json, text, type RequestHandler } from '@sveltejs/kit';
import { getResendClient, getWebhookSecret } from '$lib/server/context';
import { parseEmailIdentity } from '$lib/server/email-address';
import { parseMailDomains } from '$lib/server/email-provider';
import { claimWebhookEvent, handleResendWebhook, type ResendWebhookEvent } from '$lib/server/inbound';
import { verifyWebhookSignature } from '$lib/server/webhook';

const DELIVERY_EVENTS = new Set([
	'email.sent', 'email.delivered', 'email.delivery_delayed',
	'email.bounced', 'email.complained', 'email.failed'
]);

/**
 * Resend webhook receiver — used when EMAIL_PROVIDER=resend.
 *
 * Point a webhook at https://<your-app>/api/webhooks/resend in the Resend
 * dashboard. Cloudflare inbound with an explicit sending-domain list accepts
 * only delivery events for that list's intersection with Cloudflare domains.
 * Other configurations retain `email.received` and delivery-event handling.
 * Resend can still POST other domains' metadata; this filter does not prevent
 * receipt, but ignores it before claiming an event or writing to the database.
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const db = platform?.env.DB;
	const bucket = platform?.env.ATTACHMENTS;
	if (!db || !bucket) {
		return json({ error: 'Storage unavailable' }, { status: 503 });
	}

	const secret = getWebhookSecret(platform);
	if (!secret) {
		console.error('Rejected webhook: RESEND_WEBHOOK_SECRET is not configured');
		return json({ error: 'Webhook secret not configured' }, { status: 503 });
	}

	// Must be the raw body — parsing first would invalidate the signature.
	const rawBody = await request.text();
	const verified = await verifyWebhookSignature(request.headers, rawBody, secret);
	if (!verified.ok) {
		console.warn('Rejected webhook signature:', verified.reason);
		return json({ error: 'Invalid signature' }, { status: 401 });
	}

	let event: ResendWebhookEvent;
	try {
		event = JSON.parse(rawBody) as ResendWebhookEvent;
	} catch {
		return json({ error: 'Invalid JSON payload' }, { status: 400 });
	}

	if (!event?.type) {
		return json({ error: 'Missing event type' }, { status: 400 });
	}

	if (platform?.env.INBOUND_EMAIL_PROVIDER === 'cloudflare' &&
		platform.env.RESEND_VERIFIED_SEND_DOMAINS !== undefined) {
		const from = typeof event.data?.from === 'string'
			? parseEmailIdentity(event.data.from).address.split('@') : [];
		const fromDomain = from.length === 2 && from[0] ? from[1] : null;
		const cloudflareDomains = new Set(parseMailDomains(platform.env.CLOUDFLARE_MAIL_DOMAINS));
		const allowed = parseMailDomains(platform.env.RESEND_VERIFIED_SEND_DOMAINS)
			.some((domain) => domain === fromDomain && cloudflareDomains.has(domain));
		if (!DELIVERY_EVENTS.has(event.type) || !allowed) {
			return text('Event outside configured scope ignored', { status: 200 });
		}
	}

	const eventId =
		request.headers.get('svix-id') ?? request.headers.get('webhook-id') ?? crypto.randomUUID();

	// Resend retries; only the first claim of an id does the work.
	const claimed = await claimWebhookEvent(db, eventId, event.type);
	if (!claimed) {
		return text('Duplicate event ignored', { status: 200 });
	}

	try {
		const client = getResendClient(platform);
		const outcome = await handleResendWebhook(
			event,
			{
				DB: db,
				ATTACHMENTS: bucket,
				VAPID_PUBLIC_KEY: platform?.env.VAPID_PUBLIC_KEY,
				VAPID_PRIVATE_KEY: platform?.env.VAPID_PRIVATE_KEY,
				VAPID_SUBJECT: platform?.env.VAPID_SUBJECT,
				TELEGRAM_BOT_TOKEN: platform?.env.TELEGRAM_BOT_TOKEN,
				TELEGRAM_CHAT_ID: platform?.env.TELEGRAM_CHAT_ID,
				TELEGRAM_THREAD_ID: platform?.env.TELEGRAM_THREAD_ID,
				APP_URL: platform?.env.APP_URL,
				TYPESAFE_API_KEY: platform?.env.TYPESAFE_API_KEY,
				waitUntil: platform?.ctx ? (promise) => platform.ctx.waitUntil(promise) : undefined
			},
			client
		);
		return json({ ok: true, ...outcome });
	} catch (error) {
		// Release the claim so Resend's retry can succeed.
		await db.prepare('DELETE FROM webhook_events WHERE id = ?').bind(eventId).run();
		console.error('Webhook handling failed', event.type, error);
		return json(
			{ error: error instanceof Error ? error.message : 'Webhook handling failed' },
			{ status: 500 }
		);
	}
};
