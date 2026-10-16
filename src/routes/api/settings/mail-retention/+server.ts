import { json, type RequestHandler } from '@sveltejs/kit';
import { AuthRequestError, readAuthRequestBody } from '$lib/server/auth';
import { getMailRetentionSettings, setMailRetentionSettings, type MailRetentionSettings } from '$lib/server/mail-retention';

const headers = { 'Cache-Control': 'no-store' };
const fields = ['readEnabled', 'readDays', 'trashEnabled', 'trashDays'];

function validSettings(body: Record<string, unknown>): body is Record<string, unknown> & MailRetentionSettings {
	return Object.keys(body).length === fields.length && fields.every((field) => Object.hasOwn(body, field))
		&& typeof body.readEnabled === 'boolean' && typeof body.trashEnabled === 'boolean'
		&& typeof body.readDays === 'number' && Number.isInteger(body.readDays) && body.readDays >= 1 && body.readDays <= 3650
		&& typeof body.trashDays === 'number' && Number.isInteger(body.trashDays) && body.trashDays >= 1 && body.trashDays <= 3650;
}

export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!platform?.env.DB || !locals.user || locals.authMethod !== 'session' || !locals.currentSessionId) {
		return json({ error: 'Sign in with a browser session' }, { status: 401, headers });
	}
	if (locals.user.must_change_password) return json({ error: 'Complete account setup first' }, { status: 403, headers });
	const settings = await getMailRetentionSettings(platform.env.DB, locals.user.id);
	return settings ? json(settings, { headers }) : json({ error: 'Account unavailable' }, { status: 401, headers });
};

export const PATCH: RequestHandler = async ({ locals, platform, request, url }) => {
	if (!platform?.env.DB || !locals.user || locals.authMethod !== 'session' || !locals.currentSessionId) {
		return json({ error: 'Sign in with a browser session' }, { status: 401, headers });
	}
	if (locals.user.must_change_password) return json({ error: 'Complete account setup first' }, { status: 403, headers });
	if (request.headers.get('origin') !== url.origin) return json({ error: 'Invalid request origin' }, { status: 403, headers });
	try {
		const body = await readAuthRequestBody(request);
		if (!validSettings(body)) return json({ error: 'Provide both retention switches and integer days from 1 to 3650' }, { status: 400, headers });
		if (!await setMailRetentionSettings(platform.env.DB, locals.user.id, body)) {
			return json({ error: 'Account unavailable' }, { status: 401, headers });
		}
		return json(body, { headers });
	} catch (error) {
		return json({ error: error instanceof AuthRequestError ? error.message : 'Could not save retention settings' },
			{ status: error instanceof AuthRequestError ? error.status : 500, headers });
	}
};
