import { json, type RequestHandler } from '@sveltejs/kit';
import {
	AI_OAUTH_COOKIE,
	AI_OAUTH_COOKIE_PATH,
	AI_OAUTH_TTL_SECONDS,
	AiOAuthError,
	beginOpenRouterOAuth
} from '$lib/server/ai-oauth';

/** A connection can be started only by the current browser mailbox session. */
export const POST: RequestHandler = async ({ request, url, locals, platform, cookies }) => {
	const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
	if (!locals.user || locals.authMethod !== 'session' || !locals.currentSessionId) {
		return json({ error: 'Sign in to the mailbox in this browser before connecting OpenRouter.' }, { status: 401, headers });
	}
	if (request.headers.get('origin') !== url.origin) {
		return json({ error: 'Start OpenRouter authorization from this mailbox website.' }, { status: 403, headers });
	}
	const db = platform?.env.DB;
	if (!db) return json({ error: 'The mailbox database is unavailable.' }, { status: 503, headers });
	try {
		const result = await beginOpenRouterOAuth(db, platform.env, {
			userId: locals.user.id, sessionId: locals.currentSessionId
		}, url.origin);
		cookies.set(AI_OAUTH_COOKIE, result.browserSecret, {
			path: AI_OAUTH_COOKIE_PATH, httpOnly: true, secure: url.protocol === 'https:',
			sameSite: 'lax', maxAge: AI_OAUTH_TTL_SECONDS
		});
		return json({ url: result.url }, { headers });
	} catch (error) {
		if (error instanceof AiOAuthError) return json({ error: error.message }, { status: error.status, headers });
		return json({ error: 'OpenRouter authorization could not be started. Try again.' }, { status: 500, headers });
	}
};
