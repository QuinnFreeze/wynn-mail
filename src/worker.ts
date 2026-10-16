import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { attachKvStorage } from './lib/server/kv-attachments';
import { runMailRetention } from './lib/server/mail-retention';
import { drainMailStorageCleanup } from './lib/server/mail-deletion';
import {
	handleCloudflareInbound,
	type CloudflareInboundEnv,
	type CloudflareInboundMessage
} from './lib/server/cloudflare-inbound';
// Renamed from `_worker.js` by `scripts/wrap-cloudflare-worker.mjs` after `vite build`.
// @ts-ignore generated entry and its declaration are created at build time
import sveltekit from '../.svelte-kit/cloudflare/_sveltekit.js';

type SvelteKitWorker = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
};

const svelteApp = sveltekit as SvelteKitWorker;

/**
 * SvelteKit's generated Worker is fetch-only. This wrapper keeps HTTP on
 * SvelteKit and adds inbound mail and hourly, user-controlled retention.
 */
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		if (typeof svelteApp.fetch !== 'function') {
			throw new Error('SvelteKit worker export is missing fetch');
		}
		return svelteApp.fetch(request, attachKvStorage(env), ctx);
	},

	async scheduled(controller: ScheduledController, env: Env) {
		attachKvStorage(env);
		const mail = await runMailRetention(env.DB, env.ATTACHMENTS, controller.scheduledTime);
		const storage = await drainMailStorageCleanup(env.DB, env.ATTACHMENTS);
		// Aggregate operational counts only: no identities, subjects or storage keys.
		console.info(JSON.stringify({ event: 'mail-retention', ...mail, storage }));
	},

	async email(message: CloudflareInboundMessage, env: Env, ctx: ExecutionContext) {
		if ((env.INBOUND_EMAIL_PROVIDER ?? env.EMAIL_PROVIDER)?.trim().toLowerCase() !== 'cloudflare') {
			message.setReject('Cloudflare email provider is not enabled');
			return;
		}

		attachKvStorage(env);
		const inboundEnv: CloudflareInboundEnv = {
			DB: env.DB,
			ATTACHMENTS: env.ATTACHMENTS,
			VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
			VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
			VAPID_SUBJECT: env.VAPID_SUBJECT,
			TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
			TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID,
			TELEGRAM_THREAD_ID: env.TELEGRAM_THREAD_ID,
			APP_URL: env.APP_URL,
			TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
			waitUntil: (promise) => ctx.waitUntil(promise)
		};

		await handleCloudflareInbound(message, inboundEnv);
	}
};
