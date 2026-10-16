import type { D1Database } from '@cloudflare/workers-types';
import { AiProviderError, saveOpenRouterOAuthProvider, type AiEnv, type AiProviderSummary } from './ai-provider';
import { advanceAiConnectionStatement } from './ai-connection';
import { configuredEncryptionKey, openSecret, sealSecret } from './secret-box';

export const AI_OAUTH_COOKIE = 'ai_openrouter_oauth';
export const AI_OAUTH_COOKIE_PATH = '/api/settings/ai/oauth/openrouter';
export const AI_OAUTH_CALLBACK_PATH = `${AI_OAUTH_COOKIE_PATH}/callback`;
export const AI_OAUTH_TTL_SECONDS = 10 * 60;
const OPENROUTER_AUTHORIZE_URL = 'https://openrouter.ai/auth';
const OPENROUTER_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
const TOKEN_TIMEOUT_MS = 20_000;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;

export type AiOAuthEnv = AiEnv & { APP_URL?: string };
export type AiOAuthFailure = 'unavailable' | 'invalid' | 'expired' | 'cancelled' | 'failed';

export class AiOAuthError extends Error {
	constructor(
		readonly code: AiOAuthFailure,
		message: string,
		readonly status = 400
	) {
		super(message);
		this.name = 'AiOAuthError';
	}
}

export type AiOAuthIdentity = { userId: string; sessionId: string };

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

function randomValue(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return base64Url(new Uint8Array(digest));
}

/** Use only deployment configuration, never a browser-supplied callback URL. */
function appOrigin(env: AiOAuthEnv): string {
	try {
		const url = new URL(env.APP_URL ?? '');
		const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
		if (
			url.username || url.password || url.search || url.hash ||
			(url.pathname !== '/' && url.pathname !== '') ||
			(url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
		) throw new Error('Invalid APP_URL');
		return url.origin;
	} catch {
		throw new AiOAuthError('unavailable', 'Set APP_URL to the public HTTPS URL before connecting OpenRouter.', 503);
	}
}

function encryptionKey(env: AiOAuthEnv): string {
	const key = configuredEncryptionKey(env.ENCRYPTION_KEY);
	if (!key) {
		throw new AiOAuthError('unavailable', 'This server needs ENCRYPTION_KEY before it can connect OpenRouter.', 503);
	}
	return key;
}

export function openRouterOAuthAvailable(env: AiOAuthEnv): boolean {
	try {
		appOrigin(env);
		encryptionKey(env);
		return true;
	} catch {
		return false;
	}
}

async function requireSession(db: D1Database, identity: AiOAuthIdentity): Promise<void> {
	const valid = identity.userId && identity.sessionId && await db
		.prepare(
			`SELECT 1 AS found FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.id = ? AND s.user_id = ? AND s.device_platform IS NULL
			   AND datetime(s.expires_at) > datetime('now') AND u.must_change_password = 0`
		)
		.bind(identity.sessionId, identity.userId)
		.first();
	if (!valid) throw new AiOAuthError('expired', 'Sign in to the same mailbox again before connecting OpenRouter.', 401);
}

/** The browser binding is returned only to the route that sets an HttpOnly cookie. */
export async function beginOpenRouterOAuth(
	db: D1Database,
	env: AiOAuthEnv,
	identity: AiOAuthIdentity,
	requestOrigin: string,
	now = Date.now()
): Promise<{ url: string; browserSecret: string }> {
	const secret = encryptionKey(env);
	const origin = appOrigin(env);
	if (requestOrigin !== origin) throw new AiOAuthError('invalid', 'OpenRouter must be connected from this mailbox website.', 403);
	await requireSession(db, identity);
	const state = randomValue();
	const browserSecret = randomValue();
	const verifier = randomValue();
	const stateHash = await sha256(state);
	const redirectUri = `${origin}${AI_OAUTH_CALLBACK_PATH}`;
	const verifierSealed = await sealSecret(secret, verifier, `ai_oauth:${stateHash}`);
	await db.batch([
		advanceAiConnectionStatement(db, identity.userId),
		db.prepare('DELETE FROM ai_oauth_transactions WHERE expires_at <= ? OR user_id = ?')
			.bind(now, identity.userId),
		db.prepare(
			`INSERT INTO ai_oauth_transactions
			 (state_hash, user_id, session_id, browser_hash, verifier_sealed, redirect_uri, expires_at, generation)
			 SELECT ?, ?, ?, ?, ?, ?, ?, generation FROM ai_connection_generations WHERE user_id = ?`
		).bind(stateHash, identity.userId, identity.sessionId, await sha256(browserSecret), verifierSealed,
			redirectUri, now + AI_OAUTH_TTL_SECONDS * 1_000, identity.userId)
	]);
	const url = new URL(OPENROUTER_AUTHORIZE_URL);
	url.searchParams.set('callback_url', redirectUri);
	url.searchParams.set('code_challenge', await sha256(verifier));
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);
	url.searchParams.set('key_label', 'Wynn Mail AI drafting');
	return { url: url.toString(), browserSecret };
}

/** Discard only the current browser's transaction after a cancelled flow. */
export async function cancelOpenRouterOAuth(
	db: D1Database,
	identity: AiOAuthIdentity,
	browserSecret: string | undefined
): Promise<void> {
	if (!browserSecret || !RANDOM_VALUE.test(browserSecret)) return;
	await db.prepare(
		'DELETE FROM ai_oauth_transactions WHERE user_id = ? AND session_id = ? AND browser_hash = ?'
	).bind(identity.userId, identity.sessionId, await sha256(browserSecret)).run();
}

export async function completeOpenRouterOAuth(
	db: D1Database,
	env: AiOAuthEnv,
	identity: AiOAuthIdentity,
	input: { state: string | null; code: string | null; browserSecret: string | undefined; requestOrigin: string },
	fetcher: typeof fetch = fetch,
	now = Date.now()
): Promise<AiProviderSummary> {
	const secret = encryptionKey(env);
	const origin = appOrigin(env);
	if (
		input.requestOrigin !== origin || !input.state || !RANDOM_VALUE.test(input.state) ||
		!input.browserSecret || !RANDOM_VALUE.test(input.browserSecret) ||
		!input.code || input.code.length > 2_048 || /[\x00-\x20\x7f]/.test(input.code)
	) throw new AiOAuthError('invalid', 'This OpenRouter authorization could not be verified. Start again.');
	await requireSession(db, identity);
	// DELETE ... RETURNING is the atomic claim: even concurrent callbacks may
	// exchange a given authorization only once. Wrong users/browsers cannot claim it.
	const transaction = await db.prepare(
		`DELETE FROM ai_oauth_transactions
		 WHERE state_hash = ? AND user_id = ? AND session_id = ? AND browser_hash = ?
		 RETURNING verifier_sealed, redirect_uri, expires_at, generation`
	).bind(await sha256(input.state), identity.userId, identity.sessionId, await sha256(input.browserSecret))
		.first<{ verifier_sealed: string; redirect_uri: string; expires_at: number; generation: number }>();
	if (!transaction) throw new AiOAuthError('invalid', 'This OpenRouter authorization was already used or could not be verified. Start again.');
	if (transaction.expires_at <= now) throw new AiOAuthError('expired', 'OpenRouter authorization expired. Start again.');
	if (transaction.redirect_uri !== `${origin}${AI_OAUTH_CALLBACK_PATH}`) {
		throw new AiOAuthError('invalid', 'The mailbox URL changed. Start OpenRouter authorization again.');
	}
	let verifier: string;
	try {
		verifier = await openSecret(secret, transaction.verifier_sealed, `ai_oauth:${await sha256(input.state)}`);
	} catch {
		throw new AiOAuthError('invalid', 'This OpenRouter authorization could not be verified. Start again.');
	}
	let response: Response;
	try {
		response = await fetcher(OPENROUTER_EXCHANGE_URL, {
			method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: input.code, code_verifier: verifier, code_challenge_method: 'S256' }),
			signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
		});
	} catch {
		throw new AiOAuthError('failed', 'Could not reach OpenRouter. Start authorization again.', 502);
	}
	// Provider bodies and errors can contain credentials; never expose or log them.
	if (!response.ok) throw new AiOAuthError('failed', 'OpenRouter could not complete authorization. Start again.', 502);
	const body = await response.json().catch(() => null) as { key?: unknown } | null;
	if (typeof body?.key !== 'string' || !body.key.startsWith('sk-or-') || body.key.length > 1_000 || /\s/.test(body.key)) {
		throw new AiOAuthError('failed', 'OpenRouter did not return a valid connection. Start again.', 502);
	}
	// Recheck revocation after network latency before installing the new connection.
	await requireSession(db, identity);
	try {
		return await saveOpenRouterOAuthProvider(db, env, identity.userId, body.key, {
			generation: transaction.generation, sessionId: identity.sessionId
		});
	} catch (error) {
		if (error instanceof AiProviderError && error.status === 409) {
			throw new AiOAuthError('invalid', 'The AI connection changed while authorizing. Start again.');
		}
		throw error;
	}
}
