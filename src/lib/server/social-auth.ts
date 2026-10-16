import type { D1Database } from '@cloudflare/workers-types';
import type { Cookies } from '@sveltejs/kit';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { hashToken } from './crypto';
import { getUserById } from './auth';
import { safeNextPath } from '$lib/next-url';

export const SOCIAL_PROVIDERS = ['google', 'github'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];
export const SOCIAL_FLOW_SECONDS = 600;

export type SocialAuthEnvironment = {
	APP_URL?: string;
	OAUTH_GOOGLE_CLIENT_ID?: string;
	OAUTH_GOOGLE_CLIENT_SECRET?: string;
	OAUTH_GITHUB_CLIENT_ID?: string;
	OAUTH_GITHUB_CLIENT_SECRET?: string;
};

export class SocialAuthError extends Error {
	constructor(public readonly status: number, message: string) { super(message); }
}

export function isSocialProvider(value: unknown): value is SocialProvider {
	return value === 'google' || value === 'github';
}

export function socialAppOrigin(env: SocialAuthEnvironment): string {
	let url: URL;
	try { url = new URL(env.APP_URL ?? ''); }
	catch { throw new SocialAuthError(503, 'Social sign-in is not configured'); }
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
		url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
		throw new SocialAuthError(503, 'Social sign-in requires a fixed application origin');
	}
	return url.origin;
}

export function requireSocialOrigin(env: SocialAuthEnvironment, url: URL, request?: Request): string {
	const origin = socialAppOrigin(env);
	if (url.origin !== origin || (request && request.headers.get('origin') !== origin)) {
		throw new SocialAuthError(403, 'Invalid request origin');
	}
	return origin;
}

function configured(value: string | undefined): string | undefined {
	const clean = value?.trim();
	return clean && !/^REPLACE_WITH_/i.test(clean) ? clean : undefined;
}

export function socialConfiguration(env: SocialAuthEnvironment, provider: SocialProvider) {
	const clientId = configured(provider === 'google' ? env.OAUTH_GOOGLE_CLIENT_ID : env.OAUTH_GITHUB_CLIENT_ID);
	const clientSecret = configured(provider === 'google' ? env.OAUTH_GOOGLE_CLIENT_SECRET : env.OAUTH_GITHUB_CLIENT_SECRET);
	if (!clientId || !clientSecret) return null;
	try {
		const origin = socialAppOrigin(env);
		return { clientId, clientSecret, redirectUri: `${origin}/api/auth/social/${provider}/callback` };
	} catch { return null; }
}

export function configuredSocialProviders(env: SocialAuthEnvironment): SocialProvider[] {
	return SOCIAL_PROVIDERS.filter((provider) => socialConfiguration(env, provider) !== null);
}

function randomToken(): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
		.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function socialPkceChallenge(verifier: string): Promise<string> {
	return (await hashToken(verifier)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function socialCookieName(provider: SocialProvider, url: URL): string {
	return `${url.protocol === 'https:' ? '__Host-' : ''}quickinbox-social-${provider}`;
}

export function socialCookieOptions(url: URL) {
	return { path: '/', httpOnly: true, secure: url.protocol === 'https:', sameSite: 'lax' as const, maxAge: SOCIAL_FLOW_SECONDS };
}

export type SocialTransaction = {
	provider: SocialProvider;
	code_challenge: string;
	nonce_hash: string;
	intent: 'login' | 'link';
	initiator_user_id: string | null;
	initiator_session_id: string | null;
	next_path: string | null;
	add_account: number;
	expires_at: string;
};

export async function beginSocialFlow(
	db: D1Database, env: SocialAuthEnvironment, provider: SocialProvider,
	cookies: Pick<Cookies, 'set'>, url: URL,
	input: { intent: 'login' | 'link'; userId: string | null; sessionId: string | null; next?: string; add?: boolean }
): Promise<string> {
	const config = socialConfiguration(env, provider);
	if (!config) throw new SocialAuthError(503, 'This sign-in provider is not configured');
	if (input.intent === 'link' && (!input.userId || !input.sessionId)) {
		throw new SocialAuthError(401, 'Sign in to your mailbox before connecting an account');
	}
	const state = randomToken();
	const binding = randomToken();
	const verifier = randomToken();
	const nonce = randomToken();
	const challenge = await socialPkceChallenge(verifier);
	await db.prepare('DELETE FROM social_login_transactions WHERE datetime(expires_at) <= datetime(\'now\')').run();
	await db.prepare(
		`INSERT INTO social_login_transactions
		 (state_hash, provider, browser_hash, code_challenge, nonce_hash, intent,
		  initiator_user_id, initiator_session_id, next_path, add_account, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).bind(await hashToken(state), provider, await hashToken(binding), challenge, await hashToken(nonce),
		input.intent, input.userId, input.sessionId, safeNextPath(input.next), input.add ? 1 : 0,
		new Date(Date.now() + SOCIAL_FLOW_SECONDS * 1000).toISOString()).run();
	cookies.set(socialCookieName(provider, url), JSON.stringify({ binding, verifier }), socialCookieOptions(url));
	const auth = new URL(provider === 'google'
		? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://github.com/login/oauth/authorize');
	auth.searchParams.set('client_id', config.clientId);
	auth.searchParams.set('redirect_uri', config.redirectUri);
	auth.searchParams.set('response_type', 'code');
	auth.searchParams.set('state', state);
	auth.searchParams.set('code_challenge', challenge);
	auth.searchParams.set('code_challenge_method', 'S256');
	if (provider === 'google') {
		auth.searchParams.set('scope', 'openid email');
		auth.searchParams.set('nonce', nonce);
		auth.searchParams.set('prompt', 'select_account');
	} else {
		// Basic public identity only; no email, repository or write permission.
		auth.searchParams.set('scope', '');
		auth.searchParams.set('allow_signup', 'false');
		auth.searchParams.set('prompt', 'select_account');
	}
	return auth.toString();
}

export async function consumeSocialFlow(
	db: D1Database, provider: SocialProvider, cookies: Pick<Cookies, 'get' | 'delete'>, url: URL, state: string | null
): Promise<{ transaction: SocialTransaction; verifier: string }> {
	const name = socialCookieName(provider, url);
	const raw = cookies.get(name);
	cookies.delete(name, { path: '/' });
	let cookie: { binding?: unknown; verifier?: unknown };
	try { cookie = JSON.parse(raw ?? ''); }
	catch { throw new SocialAuthError(400, 'Sign-in expired. Start again.'); }
	if (!state || !/^[\w-]{43}$/.test(state) || !cookie ||
		typeof cookie.binding !== 'string' || !/^[\w-]{43}$/.test(cookie.binding) ||
		typeof cookie.verifier !== 'string' || !/^[\w-]{43}$/.test(cookie.verifier)) {
		throw new SocialAuthError(400, 'Invalid sign-in state');
	}
	// One statement consumes the transaction, so concurrent callbacks cannot
	// both link an identity or mint sessions. A different browser cannot consume it.
	const transaction = await db.prepare(
		`DELETE FROM social_login_transactions
		 WHERE state_hash = ? AND provider = ? AND browser_hash = ?
		 AND code_challenge = ? AND datetime(expires_at) > datetime('now')
		 RETURNING provider, code_challenge, nonce_hash, intent, initiator_user_id,
		 initiator_session_id, next_path, add_account, expires_at`
	).bind(await hashToken(state), provider, await hashToken(cookie.binding),
		await socialPkceChallenge(cookie.verifier)).first<SocialTransaction>();
	if (!transaction) throw new SocialAuthError(400, 'Sign-in expired or already used. Start again.');
	return { transaction, verifier: cookie.verifier };
}

export function validateSocialInitiator(transaction: SocialTransaction, userId: string | null, sessionId: string | null): void {
	if (transaction.initiator_user_id !== userId || transaction.initiator_session_id !== sessionId) {
		throw new SocialAuthError(403, 'Your mailbox session changed. Start again.');
	}
	if (transaction.intent === 'link' && (!userId || !sessionId)) {
		throw new SocialAuthError(401, 'Sign in to your mailbox before connecting an account');
	}
}

/** Recheck the database after provider latency; locals is only a request snapshot. */
export async function requireLiveSocialInitiator(db: D1Database, transaction: SocialTransaction): Promise<void> {
	if (transaction.initiator_user_id === null && transaction.initiator_session_id === null && transaction.intent === 'login') return;
	const found = await db.prepare(
		`SELECT 1 AS found FROM sessions s JOIN users u ON u.id = s.user_id
		 WHERE s.id = ? AND s.user_id = ? AND s.device_platform IS NULL
		 AND datetime(s.expires_at) > datetime('now') AND u.must_change_password = 0`
	).bind(transaction.initiator_session_id, transaction.initiator_user_id).first();
	if (!found) throw new SocialAuthError(401, 'Your mailbox session expired. Start again.');
}

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export async function verifyGoogleIdentity(
	idToken: string, clientId: string, nonceHash: string, keySet: JWTVerifyGetKey = GOOGLE_JWKS
): Promise<{ subject: string; displayName: string }> {
	try {
		const { payload } = await jwtVerify(idToken, keySet, {
			issuer: ['https://accounts.google.com', 'accounts.google.com'],
			audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce']
		});
		if (typeof payload.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(payload.sub) ||
			typeof payload.nonce !== 'string' || await hashToken(payload.nonce) !== nonceHash ||
			(payload.azp !== undefined && payload.azp !== clientId) ||
			(Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) {
			throw new Error('Invalid identity claims');
		}
		const email = typeof payload.email === 'string' && payload.email_verified === true ? payload.email : '';
		return { subject: payload.sub, displayName: (email || 'Google account').slice(0,320) };
	} catch { throw new SocialAuthError(403, 'Google could not verify this account'); }
}

const MAX_PROVIDER_RESPONSE_BYTES = 65_536;

/** Bound bytes while streaming, including error bodies and chunked responses. */
async function readProviderJson(response: Response): Promise<Record<string, unknown>> {
	const invalid = () => new SocialAuthError(502, 'Invalid response from sign-in provider');
	const contentLength = Number(response.headers.get('content-length') ?? '0');
	if (contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		throw invalid();
	}
	if (!response.body) throw invalid();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_PROVIDER_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw invalid();
			}
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	let body: unknown;
	try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
	catch { throw invalid(); }
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
	return body as Record<string, unknown>;
}

async function providerJson(url: string, init: RequestInit, fetcher: typeof fetch): Promise<Record<string, unknown>> {
	const endpoint = url === 'https://oauth2.googleapis.com/token' ? 'google_token'
		: url === 'https://github.com/login/oauth/access_token' ? 'github_token' : 'github_profile';
	let response: Response;
	// Workers supports manual redirects; reject every non-2xx response below
	// instead of following redirects that could forward client credentials.
	try { response = await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: 'manual' }); }
	catch (error) {
		// Classify native fetch failures without logging the exception or request.
		const message = error instanceof Error ? error.message : '';
		const kind = error instanceof Error && ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'unknown';
		const category = /redirect/i.test(message) ? 'redirect_mode'
			: /illegal invocation/i.test(message) ? 'invocation'
			: /dns|resolve/i.test(message) ? 'dns'
			: /timeout|abort/i.test(message) ? 'timeout'
			: /ssl|tls|certificate/i.test(message) ? 'tls'
			: /network|connection|socket/i.test(message) ? 'connection'
			: /context|different request|I\/O/i.test(message) ? 'request_context'
			: /not a function|undefined/i.test(message) ? 'unsupported_api'
			: /subrequests|limit/i.test(message) ? 'request_limit' : 'other';
		console.warn('social-provider-response', { endpoint, status: 0, reason: 'network_error', kind, category });
		throw new SocialAuthError(502, 'The sign-in provider is unavailable. Try again.');
	}
	let body: Record<string, unknown> | null = null;
	try { body = await readProviderJson(response); }
	catch { /* Malformed or oversized provider details are deliberately discarded. */ }
	if (!response.ok) {
		let reason = 'other';
		if (body?.error === 'invalid_client' || body?.error === 'invalid_grant' || body?.error === 'invalid_request') reason = body.error;
		console.warn('social-provider-response', { endpoint, status: response.status, reason });
		throw new SocialAuthError(502, 'The sign-in provider rejected this request');
	}
	if (!body) throw new SocialAuthError(502, 'Invalid response from sign-in provider');
	return body;
}

export async function exchangeSocialIdentity(
	env: SocialAuthEnvironment, provider: SocialProvider, code: string, verifier: string,
	nonceHash: string, fetcher: typeof fetch = fetch,
	googleKeys?: JWTVerifyGetKey
): Promise<{ subject: string; displayName: string }> {
	const config = socialConfiguration(env, provider);
	if (!config) throw new SocialAuthError(503, 'This sign-in provider is not configured');
	if (!code || code.length > 4096) throw new SocialAuthError(400, 'Invalid authorization code');
	const token = await providerJson(provider === 'google'
		? 'https://oauth2.googleapis.com/token' : 'https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId,
			client_secret: config.clientSecret, code, code_verifier: verifier, redirect_uri: config.redirectUri })
	}, fetcher);
	if (provider === 'google') {
		if (typeof token.id_token !== 'string' || token.id_token.length > 32_768) {
			throw new SocialAuthError(403, 'Google could not verify this account');
		}
		return verifyGoogleIdentity(token.id_token, config.clientId, nonceHash, googleKeys);
	}
	if (typeof token.access_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token.access_token)) {
		throw new SocialAuthError(403, 'GitHub could not verify this account');
	}
	const profile = await providerJson('https://api.github.com/user', {
		headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'QuickInbox-Social-Login' }
	}, fetcher);
	if (!Number.isSafeInteger(profile.id) || Number(profile.id) <= 0) {
		throw new SocialAuthError(403, 'GitHub could not verify this account');
	}
	return { subject: String(profile.id), displayName: typeof profile.login === 'string' ? profile.login.slice(0,100) : 'GitHub account' };
}

export async function linkSocialIdentity(db: D1Database, userId: string, provider: SocialProvider,
	identity: { subject: string; displayName: string }, requiredSessionId?: string): Promise<void> {
	// Immutable link: an already-connected provider must be disconnected first.
	// Never overwrite another user's subject or silently replace a login identity.
	const result = await db.prepare(
		`INSERT INTO social_identities (provider, subject, user_id, display_name, created_at)
		 SELECT ?, ?, ?, ?, ? WHERE EXISTS
		 (SELECT 1 FROM users WHERE id = ? AND must_change_password = 0)
		 AND (? IS NULL OR EXISTS (SELECT 1 FROM sessions WHERE id = ? AND user_id = ?
		 AND device_platform IS NULL AND datetime(expires_at) > datetime('now')))
		 ON CONFLICT DO NOTHING`
	).bind(provider, identity.subject, userId, identity.displayName, new Date().toISOString(), userId,
		requiredSessionId ?? null, requiredSessionId ?? null, userId).run();
	if ((result.meta.changes ?? 0) === 0) {
		const own = await db.prepare('SELECT subject FROM social_identities WHERE user_id = ? AND provider = ?')
			.bind(userId, provider).first<{subject: string}>();
		if (own?.subject !== identity.subject) throw new SocialAuthError(409, 'This sign-in identity is already connected');
	}
}

export async function userForSocialIdentity(db: D1Database, provider: SocialProvider, subject: string) {
	const identity = await db.prepare('SELECT user_id FROM social_identities WHERE provider = ? AND subject = ?')
		.bind(provider, subject).first<{user_id: string}>();
	const user = identity ? await getUserById(db, identity.user_id) : null;
	if (!user || user.must_change_password) throw new SocialAuthError(403, 'This account is not connected. Sign in with your mailbox password first.');
	return user;
}

export async function socialIdentitySummaries(db: D1Database, env: SocialAuthEnvironment, userId: string) {
	const { results } = await db.prepare('SELECT provider, display_name, created_at FROM social_identities WHERE user_id = ?')
		.bind(userId).all<{ provider: SocialProvider; display_name: string; created_at: string }>();
	return SOCIAL_PROVIDERS.map((provider) => {
		const connected = results.find((row) => row.provider === provider);
		return { provider, configured: socialConfiguration(env, provider) !== null, connected: Boolean(connected),
			displayName: connected?.display_name ?? null, connectedAt: connected?.created_at ?? null };
	});
}

export async function unlinkSocialIdentity(db: D1Database, userId: string, provider: SocialProvider): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM social_identities WHERE user_id = ? AND provider = ?').bind(userId, provider),
		db.prepare('DELETE FROM social_login_transactions WHERE initiator_user_id = ? AND provider = ?').bind(userId, provider)
	]);
}
