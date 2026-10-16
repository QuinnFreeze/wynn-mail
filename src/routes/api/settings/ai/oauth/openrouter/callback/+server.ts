import type { RequestHandler } from '@sveltejs/kit';
import {
	AI_OAUTH_COOKIE,
	AI_OAUTH_COOKIE_PATH,
	AiOAuthError,
	cancelOpenRouterOAuth,
	completeOpenRouterOAuth
} from '$lib/server/ai-oauth';

/** Strip the provider code from the URL before displaying any mailbox page. */
function back(result: string): Response {
	return new Response(null, {
		status: 303,
		headers: {
			Location: `/settings/ai?ai_oauth=${result}`,
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer'
		}
	});
}

export const GET: RequestHandler = async ({ url, locals, platform, cookies }) => {
	const browserSecret = cookies.get(AI_OAUTH_COOKIE);
	cookies.delete(AI_OAUTH_COOKIE, { path: AI_OAUTH_COOKIE_PATH });
	if (!locals.user || locals.authMethod !== 'session' || !locals.currentSessionId) return back('expired');
	const db = platform?.env.DB;
	if (!db) return back('unavailable');
	const identity = { userId: locals.user.id, sessionId: locals.currentSessionId };
	try {
		if (url.searchParams.has('error')) {
			await cancelOpenRouterOAuth(db, identity, browserSecret);
			return back(url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed');
		}
		await completeOpenRouterOAuth(db, platform.env, identity, {
			state: url.searchParams.get('state'), code: url.searchParams.get('code'), browserSecret,
			requestOrigin: url.origin
		});
		return back('connected');
	} catch (error) {
		return back(error instanceof AiOAuthError ? error.code : 'failed');
	}
};
