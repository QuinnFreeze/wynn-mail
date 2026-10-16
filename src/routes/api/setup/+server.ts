import { json, type RequestHandler } from '@sveltejs/kit';
import {
	bootstrapAdmin,
	AuthRequestError,
	countUsers,
	login,
	matchesBootstrapToken,
	readAuthRequestBody,
	sessionCookieOptions,
	SESSION_COOKIE
} from '$lib/server/auth';
import { SESSION_DAYS } from '$lib/server/constants';
import {
	ConfigError,
	getEmailProvider,
	safeEmailProviderKind,
	hasProviderConfigured,
	ProviderError
} from '$lib/server/context';
import { createAddress, setCatchallUser, upsertDomain } from '$lib/server/domains';

export const GET: RequestHandler = async ({ platform }) => {
	const db = platform?.env.DB;
	if (!db) {
		return json({ ready: false, needsSetup: true, providerConfigured: false, providerKind: 'resend' });
	}

	const users = await countUsers(db);
	return json({
		ready: true,
		needsSetup: users === 0,
		providerConfigured: hasProviderConfigured(platform),
		providerKind: safeEmailProviderKind(platform)
	});
};

/**
 * First-run bootstrap, done in one shot: connect the chosen provider domain,
 * create the admin, claim their address, make them the catch-all, sign them in.
 */
export const POST: RequestHandler = async ({ request, cookies, platform, url }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });
	const bootstrapToken = platform?.env.BOOTSTRAP_TOKEN;
	if (typeof bootstrapToken !== 'string' || !bootstrapToken.trim()) {
		return json({ error: 'Setup is disabled until an initialization token is configured' }, { status: 503 });
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
		typeof body.bootstrapToken !== 'string' || body.bootstrapToken.length > 1024 ||
		!(await matchesBootstrapToken(body.bootstrapToken, bootstrapToken))
	) {
		return json({ error: 'Invalid initialization token' }, { status: 403 });
	}

	// The whole endpoint is only open while the app is uninitialised.
	if ((await countUsers(db)) > 0) {
		return json({ error: 'Setup already completed' }, { status: 400 });
	}

	if (typeof body.domainId !== 'string' || !body.domainId.trim() || body.domainId.length > 253) {
		return json({ error: 'Choose a domain first' }, { status: 400 });
	}
	if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) {
		return json({ error: 'Your name is required' }, { status: 400 });
	}
	if (typeof body.localPart !== 'string' || !body.localPart.trim() || body.localPart.length > 64) {
		return json({ error: 'Choose an address' }, { status: 400 });
	}
	const localPart = body.localPart.trim().toLowerCase();
	if (!/^[a-z0-9._%+-]+$/.test(localPart)) {
		return json({ error: 'Use letters, numbers and . _ % + - before the @' }, { status: 400 });
	}
	if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 1024) {
		return json({ error: 'Password must be between 8 and 1024 characters' }, { status: 400 });
	}

	try {
		const provider = getEmailProvider(platform);
		const domain = await upsertDomain(db, await provider.getDomain(body.domainId));

		const address = `${localPart}@${domain.name}`;

		// The mail address doubles as the login — one identity, not two.
		const user = await bootstrapAdmin(db, {
			email: address,
			name: body.name,
			password: body.password
		});

		await createAddress(db, { userId: user.id, domainId: domain.id, localPart });

		// The provider accepts mail for every mailbox on the domain; without a
		// catch-all anything sent to an unknown address would just pile up unrouted.
		await setCatchallUser(db, domain.id, user.id);

		const session = await login(db, address, body.password);
		if (session) {
			cookies.set(
				SESSION_COOKIE,
				session.token,
				sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60, url)
			);
		}

		return json({ ok: true, email: address, signedIn: Boolean(session) });
	} catch (error) {
		const message =
			error instanceof ConfigError || error instanceof ProviderError
				? error.message
				: error instanceof Error
					? error.message
					: 'Setup failed';

		return json({ error: message }, { status: 400 });
	}
};
