#!/usr/bin/env node
/**
 * adapter-cloudflare writes the SvelteKit fetch worker to wrangler `main`
 * (`.svelte-kit/cloudflare/_worker.js`). We keep that path so the adapter
 * does not overwrite `src/worker.ts`, then wrap the generated file with
 * Cloudflare Email Service's `email()` handler.
 */
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MARKER = '__QUICKINBOX_EMAIL_WRAPPER__';
const LEGACY_MARKER = '__QUICKMAIL_EMAIL_WRAPPER__';
const generated = path.resolve('.svelte-kit/cloudflare/_worker.js');
const sveltekit = path.resolve('.svelte-kit/cloudflare/_sveltekit.js');

if (!existsSync(generated)) {
	throw new Error('Expected .svelte-kit/cloudflare/_worker.js after `vite build`.');
}

const current = await readFile(generated, 'utf8');
if (!current.includes(MARKER) && !current.includes(LEGACY_MARKER)) {
	await rename(generated, sveltekit);
	await writeFile(
	generated,
	`/* ${MARKER} */
export { default } from '../../src/worker.ts';
`
);
}

// The renamed server entry is code, not a public static asset.
const ignorePath = path.resolve('.svelte-kit/cloudflare/.assetsignore');
const ignored = existsSync(ignorePath) ? await readFile(ignorePath, 'utf8') : '';
await writeFile(ignorePath, `${ignored.trimEnd()}\n_sveltekit.*\n*.map\n`);
await writeFile(path.resolve('.svelte-kit/cloudflare/_sveltekit.d.ts'),
	'/** Generated server entry; the source is checked before bundling. */\ndeclare const worker: { fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response> };\nexport default worker;\n');

// _headers applies to missing assets too. A transient 404 must not become an
// immutable year-long browser cache entry that prevents the app from starting.
const headersPath = path.resolve('.svelte-kit/cloudflare/_headers');
if (existsSync(headersPath)) {
	const headers = await readFile(headersPath, 'utf8');
	await writeFile(headersPath, headers.replace(
		/Cache-Control:\s*public,\s*immutable,\s*max-age=31536000/g,
		'Cache-Control: public, max-age=0, must-revalidate'
	));
}
