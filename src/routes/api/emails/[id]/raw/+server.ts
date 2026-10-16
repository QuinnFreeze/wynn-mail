import { error, type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	// hooks.server.ts authenticates /api/*; keep the route safe when called alone.
	if (!locals.user) throw error(401, 'Unauthorized');
	if (!platform?.env.DB || !platform.env.ATTACHMENTS) {
		throw error(503, 'Mail storage unavailable');
	}

	const email = await platform.env.DB
		.prepare('SELECT raw_storage_key FROM emails WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.user.id)
		.first<{ raw_storage_key: string | null }>();
	if (!email?.raw_storage_key) throw error(404, 'Original message not found');

	const original = await platform.env.ATTACHMENTS.get(email.raw_storage_key);
	if (!original) throw error(404, 'Original message not found');
	const bytes = new Uint8Array(await original.arrayBuffer());

	return new Response(bytes, {
		headers: {
			'Content-Type': 'message/rfc822',
			'Content-Disposition': `attachment; filename="${encodeURIComponent(params.id!)}.eml"`,
			'Content-Length': String(bytes.byteLength),
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff'
		}
	});
};
