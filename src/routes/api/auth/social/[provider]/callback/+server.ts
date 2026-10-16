import { json, type RequestHandler } from '@sveltejs/kit';
import {
	checkRateLimit, createBrowserSession, loginClientAddress, logout, readSessionToken,
	sessionCookieOptions, SESSION_COOKIE
} from '$lib/server/auth';
import { readLinkedTokens, resolveLinkedSessions, writeLinkedTokens } from '$lib/server/accounts';
import { MAX_LINKED_ACCOUNTS, SESSION_DAYS } from '$lib/server/constants';
import { hashToken } from '$lib/server/crypto';
import {
	consumeSocialFlow, exchangeSocialIdentity, isSocialProvider, linkSocialIdentity,
	requireLiveSocialInitiator, requireSocialOrigin, SocialAuthError, userForSocialIdentity, validateSocialInitiator
} from '$lib/server/social-auth';
import { safeNextPath } from '$lib/next-url';

function redirectTo(path: string): Response {
	return new Response(null, { status: 303, headers: { Location: path, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export const GET: RequestHandler = async ({ params, request, locals, platform, cookies, url, getClientAddress }) => {
	const db = platform?.env.DB;
	if (!db || !platform) return json({ error: 'Database unavailable' }, { status: 503 });
	if (!isSocialProvider(params.provider)) return json({ error: 'Unknown sign-in provider' }, { status: 404 });
	let intent: 'login' | 'link' = 'login';
	let phase = 'origin';
	try {
		requireSocialOrigin(platform.env, url);
		phase = 'flow';
		const { transaction, verifier } = await consumeSocialFlow(db, params.provider, cookies, url, url.searchParams.get('state'));
		intent = transaction.intent;
		phase = 'mailbox_session';
		const sessionUserId = locals.authMethod === 'session' ? locals.user?.id ?? null : null;
		const sessionId = locals.authMethod === 'session' ? locals.currentSessionId : null;
		validateSocialInitiator(transaction, sessionUserId, sessionId);
		await requireLiveSocialInitiator(db, transaction);
		if (locals.user?.must_change_password) throw new SocialAuthError(403, 'Complete account setup first');
		if (url.searchParams.has('error')) throw new SocialAuthError(403, 'Sign-in was cancelled');
		const code = url.searchParams.get('code');
		if (!code) throw new SocialAuthError(400, 'Missing authorization code');
		const ip = await hashToken(loginClientAddress(request, getClientAddress));
		if (!(await checkRateLimit(db, `social-callback:${ip}`, 30, 300))) {
			throw new SocialAuthError(429, 'Too many attempts. Try again later.');
		}
		phase = 'provider';
		const identity = await exchangeSocialIdentity(platform.env, params.provider, code, verifier, transaction.nonce_hash);
		phase = 'mailbox_session_after_provider';
		await requireLiveSocialInitiator(db, transaction);
		if (transaction.intent === 'link') {
			phase = 'link_identity';
			if (!locals.user || locals.authMethod !== 'session' || !locals.currentSessionId) {
				throw new SocialAuthError(401, 'Sign in to your mailbox before connecting an account');
			}
			await linkSocialIdentity(db, locals.user.id, params.provider, identity, locals.currentSessionId);
			return redirectTo('/settings/connections?social=connected');
		}
		phase = 'linked_identity';
		const user = await userForSocialIdentity(db, params.provider, identity.subject);
		const subjectHash = await hashToken(`${params.provider}:${identity.subject}`);
		if (!(await checkRateLimit(db, `social-identity:${subjectHash}`, 15, 300))) {
			throw new SocialAuthError(429, 'Too many attempts. Try again later.');
		}
		const existing = transaction.add_account === 1
			? await resolveLinkedSessions(db, [readSessionToken(cookies) ?? '', ...readLinkedTokens(cookies)]) : [];
		if (existing.length >= MAX_LINKED_ACCOUNTS && !existing.some((session) => session.user.id === user.id)) {
			throw new SocialAuthError(400, 'Sign out of another account first');
		}
		await requireLiveSocialInitiator(db, transaction);
		phase = 'create_session';
		const result = await createBrowserSession(db, user.id);
		await Promise.all(existing.filter((session) => session.user.id === user.id).map((session) => logout(db, session.token)));
		const parked = existing.filter((session) => session.user.id !== user.id);
		cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60, url));
		writeLinkedTokens(cookies, parked.map((session) => session.token), url);
		return redirectTo(safeNextPath(transaction.next_path) ?? '/inbox');
	} catch (error) {
		// Provider errors can contain codes, tokens or account details. Expose a
		// stable local error indicator and never echo their response or URL.
		console.warn('social-auth-failure', {
			provider: params.provider, phase,
			status: error instanceof SocialAuthError ? error.status : 500
		});
		return redirectTo(intent === 'link' ? '/settings/connections?social=error' : '/login?social=error');
	}
};
