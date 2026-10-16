import { json, type RequestHandler } from '@sveltejs/kit';
import { AuthRequestError, checkRateLimit, loginClientAddress, readAuthRequestBody } from '$lib/server/auth';
import { hashToken } from '$lib/server/crypto';
import { beginSocialFlow, isSocialProvider, requireSocialOrigin, SocialAuthError } from '$lib/server/social-auth';

export const POST: RequestHandler = async ({ params, request, locals, platform, cookies, url, getClientAddress }) => {
	const db = platform?.env.DB;
	if (!db || !platform) return json({ error: 'Database unavailable' }, { status: 503 });
	if (!isSocialProvider(params.provider)) return json({ error: 'Unknown sign-in provider' }, { status: 404 });
	try {
		requireSocialOrigin(platform.env, url, request);
		const ip = await hashToken(loginClientAddress(request, getClientAddress));
		if (!(await checkRateLimit(db, `social-start:${ip}`, 20, 300))) {
			return json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': '300' } });
		}
		const body = await readAuthRequestBody(request);
		if ((body.intent !== 'login' && body.intent !== 'link') ||
			(body.next !== undefined && typeof body.next !== 'string') ||
			(body.add !== undefined && typeof body.add !== 'boolean')) {
			throw new SocialAuthError(400, 'Invalid sign-in request');
		}
		if (locals.authMethod && locals.authMethod !== 'session') throw new SocialAuthError(403, 'Use a browser session');
		if (locals.user?.must_change_password) throw new SocialAuthError(403, 'Complete account setup first');
		if (body.intent === 'link' && (!locals.user || locals.authMethod !== 'session' || !locals.currentSessionId)) {
			throw new SocialAuthError(401, 'Sign in to your mailbox before connecting an account');
		}
		if (body.intent === 'login' && locals.user && body.add !== true) {
			throw new SocialAuthError(409, 'You are already signed in');
		}
		const target = await beginSocialFlow(db, platform.env, params.provider, cookies, url, {
			intent: body.intent, userId: locals.user?.id ?? null, sessionId: locals.currentSessionId,
			next: body.next as string | undefined, add: body.intent === 'login' && body.add === true
		});
		return json({ url: target }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error) {
		return json({ error: error instanceof SocialAuthError || error instanceof AuthRequestError ? error.message : 'Could not start sign-in' },
			{ status: error instanceof SocialAuthError || error instanceof AuthRequestError ? error.status : 500,
				headers: { 'Cache-Control': 'no-store' } });
	}
};
