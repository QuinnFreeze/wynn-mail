import { json, type RequestHandler } from '@sveltejs/kit';
import {
	AuthRequestError,
	checkRateLimit,
	login,
	loginClientAddress,
	logout,
	readAuthRequestBody,
	readSessionToken,
	sessionCookieOptions,
	SESSION_COOKIE
} from '$lib/server/auth';
import { hashToken } from '$lib/server/crypto';
import { readLinkedTokens, resolveLinkedSessions, writeLinkedTokens } from '$lib/server/accounts';
import { LINKED_SESSIONS_COOKIE, MAX_LINKED_ACCOUNTS, SESSION_DAYS } from '$lib/server/constants';

const LOGIN_WINDOW_SECONDS = 300;

function rateLimited() {
	return json(
		{ error: 'Too many attempts. Try again later.' },
		{ status: 429, headers: { 'Retry-After': String(LOGIN_WINDOW_SECONDS) } }
	);
}

export const POST: RequestHandler = async ({ request, cookies, platform, url, getClientAddress }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const ipHash = await hashToken(loginClientAddress(request, getClientAddress));
	if (!(await checkRateLimit(db, `login-ip:${ipHash}`, 30, LOGIN_WINDOW_SECONDS))) {
		return rateLimited();
	}

	let body: Record<string, unknown>;
	try {
		body = await readAuthRequestBody(request);
	} catch (error) {
		return json(
			{ error: error instanceof AuthRequestError ? error.message : 'Invalid request body' },
			{ status: error instanceof AuthRequestError ? error.status : 400 }
		);
	}
	if (
		typeof body.email !== 'string' || !body.email.trim() || body.email.length > 320 ||
		typeof body.password !== 'string' || !body.password || body.password.length > 1024 ||
		(body.add !== undefined && typeof body.add !== 'boolean')
	) {
		return json({ error: 'Enter a valid email and password' }, { status: 400 });
	}
	const email = body.email.toLowerCase().trim();
	const emailHash = await hashToken(email);
	if (!(await checkRateLimit(db, `login-email:${emailHash}`, 10, LOGIN_WINDOW_SECONDS))) {
		return rateLimited();
	}

	// `add` keeps the accounts already signed in on this browser and parks them
	// behind the new one. A plain login replaces the active session as before.
	const activeToken = readSessionToken(cookies);
	const existing = body.add === true
		? await resolveLinkedSessions(db, [activeToken ?? '', ...readLinkedTokens(cookies)])
		: [];

	if (body.add === true && existing.length >= MAX_LINKED_ACCOUNTS) {
		// Only refuse when the new login would not simply replace one of them.
		const sameUser = existing.some((session) => session.user.email === email);
		if (!sameUser) {
			return json(
				{ error: `You can be signed in to at most ${MAX_LINKED_ACCOUNTS} accounts. Log out of one first.` },
				{ status: 400 }
			);
		}
	}

	const result = await login(db, email, body.password);
	if (!result) {
		return json({ error: 'Invalid email or password' }, { status: 401 });
	}

	// Signing in again as an account that is already here replaces its old
	// session rather than leaving an orphan row behind.
	const replaced = existing.filter((session) => session.user.id === result.user.id);
	await Promise.all(replaced.map((session) => logout(db, session.token)));
	const parked = existing.filter((session) => session.user.id !== result.user.id);

	cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60, url));
	if (body.add === true) {
		writeLinkedTokens(cookies, parked.map((session) => session.token), url);
	}

	return json({ user: result.user, accounts: parked.length + 1 });
};

/**
 * Log out. By default only the active account goes; if other accounts are
 * signed in on this browser the first of them becomes active and the client is
 * told to stay in the mailbox. `?all=1` ends every session and clears both cookies.
 */
export const DELETE: RequestHandler = async ({ cookies, platform, url }) => {
	const db = platform?.env.DB;
	const activeToken = readSessionToken(cookies);
	const linked = readLinkedTokens(cookies).filter((token) => token !== activeToken);
	const everything = url.searchParams.get('all') === '1';

	if (db && activeToken) {
		await logout(db, activeToken);
	}

	if (everything) {
		if (db) await Promise.all(linked.map((token) => logout(db, token)));
		cookies.delete(SESSION_COOKIE, { path: '/' });
		cookies.delete(LINKED_SESSIONS_COOKIE, { path: '/' });
		return json({ ok: true, next: '/login' });
	}

	const remaining = db ? await resolveLinkedSessions(db, linked) : [];
	const next = remaining.shift();
	if (!next) {
		cookies.delete(SESSION_COOKIE, { path: '/' });
		cookies.delete(LINKED_SESSIONS_COOKIE, { path: '/' });
		return json({ ok: true, next: '/login' });
	}

	cookies.set(SESSION_COOKIE, next.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60, url));
	writeLinkedTokens(cookies, remaining.map((session) => session.token), url);
	return json({
		ok: true,
		next: next.user.must_change_password ? '/account/setup' : '/inbox',
		user: next.user
	});
};
