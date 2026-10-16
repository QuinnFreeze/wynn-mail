import { json, type RequestHandler } from '@sveltejs/kit';
import { createAddress, listAddressesForUser, listAllAddresses } from '$lib/server/domains';
import { getUserById } from '$lib/server/auth';
import { authorizeApiRequest } from '$lib/server/api-access';

export const GET: RequestHandler = async ({ locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const all =
		url.searchParams.get('all') === '1' &&
		locals.user.is_admin &&
		(locals.authMethod === 'session' || locals.apiScopes.includes('admin'));
	const addresses = all
		? await listAllAddresses(db)
		: await listAddressesForUser(db, locals.user.id);

	return json({ addresses });
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user || !locals.authMethod) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const access = authorizeApiRequest({
		pathname: '/api/addresses',
		method: 'POST',
		authMethod: locals.authMethod,
		scopes: locals.apiScopes
	});
	if (!access.ok) return json({ error: access.error }, { status: access.status });
	if (!locals.user.is_admin) return json({ error: 'Forbidden' }, { status: 403 });

	let body: { domainId?: unknown; localPart?: unknown; label?: unknown; userId?: unknown };
	try {
		const parsed: unknown = await request.json();
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return json({ error: 'Invalid request body' }, { status: 400 });
		}
		body = parsed as typeof body;
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}

	if (typeof body.domainId !== 'string' || !body.domainId.trim() ||
		typeof body.localPart !== 'string' || !body.localPart.trim()) {
		return json({ error: 'Pick a domain and enter an address' }, { status: 400 });
	}
	if ((body.userId !== undefined && (typeof body.userId !== 'string' || !body.userId.trim())) ||
		(body.label !== undefined && body.label !== null && typeof body.label !== 'string')) {
		return json({ error: 'Invalid account or label' }, { status: 400 });
	}

	const userId = typeof body.userId === 'string' ? body.userId.trim() : locals.user.id;
	if (!(await getUserById(db, userId))) {
		return json({ error: 'Account not found' }, { status: 404 });
	}

	try {
		const address = await createAddress(db, {
			userId,
			domainId: body.domainId,
			localPart: body.localPart,
			label: typeof body.label === 'string' ? body.label : null
		});
		return json({ address }, { status: 201 });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to create address' },
			{ status: 400 }
		);
	}
};
