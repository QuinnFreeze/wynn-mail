import type { LayoutServerLoad } from './$types';
import { listApiTokens } from '$lib/server/api-tokens';
import { getEmailSignature } from '$lib/server/email-signature';
import { listDeviceSessions } from '$lib/server/auth';
import { listConnectedApps } from '$lib/server/oauth';
import { readVapidConfiguration } from '$lib/server/push-notifications';

export const load: LayoutServerLoad = async ({ locals, platform, params }) => {
	const db = platform?.env.DB;
	// Params track section navigation without depending on unrelated query strings.
	const section = locals.uiTheme === 'classic' ? 'all' : params.section ?? 'general';
	const general = section === 'all' || section === 'general';
	const connections = section === 'all' || section === 'connections';
	const [signature, apiTokens, devices, connectedApps] = await Promise.all([
		locals.user && db && general ? getEmailSignature(db, locals.user.id) : '',
		locals.user && db && connections ? listApiTokens(db, locals.user.id) : [],
		locals.user && db && connections ? listDeviceSessions(db, locals.user.id, locals.currentSessionId) : [],
		locals.user && db && connections ? listConnectedApps(db, locals.user.id) : []
	]);
	const vapid = platform?.env ? readVapidConfiguration(platform.env) : null;

	return {
		domains: locals.domains,
		addresses: locals.addresses,
		signature,
		apiTokens,
		push: {
			configured: Boolean(vapid),
			publicKey: vapid?.publicKey ?? null
		},
		isAdmin: locals.user?.is_admin ?? false,
		devices,
		connectedApps
	};
};
