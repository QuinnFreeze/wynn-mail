import type { D1Database, R2Bucket, KVNamespace } from '@cloudflare/workers-types';
import type { WorkersAiBinding } from '$lib/server/ai-provider';
import type { CloudflareSendEmailBinding } from '$lib/server/providers/cloudflare-provider';

declare global {
	interface Env {
		DB: D1Database;
		ATTACHMENTS: R2Bucket;
		ATTACHMENTS_KV?: KVNamespace;
		BOOTSTRAP_TOKEN?: string;
		INBOUND_EMAIL_PROVIDER?: string;
		OAUTH_GOOGLE_CLIENT_ID?: string;
		OAUTH_GOOGLE_CLIENT_SECRET?: string;
		OAUTH_GITHUB_CLIENT_ID?: string;
		OAUTH_GITHUB_CLIENT_SECRET?: string;
		ASSETS: Fetcher;
		EMAIL: CloudflareSendEmailBinding;
		EMAIL_PROVIDER?: string;
		CLOUDFLARE_MAIL_DOMAINS?: string;
		RESEND_API_KEY: string;
		RESEND_WEBHOOK_SECRET: string;
		VAPID_PUBLIC_KEY?: string;
		VAPID_PRIVATE_KEY?: string;
		VAPID_SUBJECT?: string;
		TELEGRAM_BOT_TOKEN?: string;
		TELEGRAM_CHAT_ID?: string;
		TELEGRAM_THREAD_ID?: string;
		APP_URL?: string;
		TYPESAFE_API_KEY?: string;
		API_SEND_ENABLED?: string;
		API_DAILY_SEND_LIMIT?: string;
		AI?: WorkersAiBinding;
		ENCRYPTION_KEY?: string;
	}
}

export {};
