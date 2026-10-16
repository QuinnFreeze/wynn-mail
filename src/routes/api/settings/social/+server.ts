import { json, type RequestHandler } from '@sveltejs/kit';
import { AuthRequestError, readAuthRequestBody } from '$lib/server/auth';
import { isSocialProvider, requireSocialOrigin, socialIdentitySummaries, SocialAuthError, unlinkSocialIdentity } from '$lib/server/social-auth';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !platform || !locals.user || locals.authMethod !== 'session' || !locals.currentSessionId) {
		return json({ error: 'Sign in with a browser session' }, { status: 401 });
	}
	if (locals.user.must_change_password) return json({ error: 'Complete account setup first' }, { status: 403 });
	return json({ providers: await socialIdentitySummaries(db, platform.env, locals.user.id) }, { headers: { 'Cache-Control': 'no-store' } });
};

export const DELETE: RequestHandler = async ({ locals, platform, request, url }) => {
	const db = platform?.env.DB;
	if (!db || !platform || !locals.user || locals.authMethod !== 'session' || !locals.currentSessionId) {
		return json({ error: 'Sign in with a browser session' }, { status: 401 });
	}
	if (locals.user.must_change_password) return json({ error: 'Complete account setup first' }, { status: 403 });
	try {
		requireSocialOrigin(platform.env, url, request);
		const body = await readAuthRequestBody(request);
		if (!isSocialProvider(body.provider)) throw new SocialAuthError(400, 'Unknown sign-in provider');
		await unlinkSocialIdentity(db, locals.user.id, body.provider);
		return json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error) {
		return json({ error: error instanceof SocialAuthError || error instanceof AuthRequestError ? error.message : 'Could not disconnect account' },
			{ status: error instanceof SocialAuthError || error instanceof AuthRequestError ? error.status : 500 });
	}
};
