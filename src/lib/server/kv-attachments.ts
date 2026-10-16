import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types';

/** The upstream mail store only uses put/get/delete. Keep those operations on
 * free Workers KV so this install never needs an R2 billing subscription. */
export function createKvAttachmentStore(kv: KVNamespace): R2Bucket {
	const store = {
		async put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream, options?: {
			httpMetadata?: { contentType?: string };
			customMetadata?: Record<string, string>;
		}) {
			const bytes = typeof value === 'string'
				? new TextEncoder().encode(value)
				: ArrayBuffer.isView(value)
					? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
					: value instanceof ArrayBuffer ? new Uint8Array(value)
						: new Uint8Array(await new Response(value).arrayBuffer());
			if (bytes.byteLength > 5 * 1024 * 1024) throw new Error('Mail storage object exceeds 5 MiB');
			await kv.put(key, bytes, { metadata: {
				contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream',
				filename: options?.customMetadata?.filename?.slice(0, 200)
			} });
			return null;
		},
		async get(key: string) {
			const { value, metadata } = await kv.getWithMetadata<{ contentType?: string; filename?: string }>(key, 'arrayBuffer');
			if (value === null) return null;
			const contentType = metadata?.contentType ?? 'application/octet-stream';
			return {
				key,
				size: value.byteLength,
				body: new Response(value).body,
				httpMetadata: { contentType },
				customMetadata: { filename: metadata?.filename ?? '' },
				arrayBuffer: async () => value,
				writeHttpMetadata(headers: Headers) { headers.set('Content-Type', contentType); }
			};
		},
		async delete(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys]) await kv.delete(key);
		}
	};
	// Intentional compatibility boundary; this adapter does not expose the rest
	// of R2 (listing, multipart or conditional writes), which the app never uses.
	return store as unknown as R2Bucket;
}

export function attachKvStorage<T extends { ATTACHMENTS?: R2Bucket; ATTACHMENTS_KV?: KVNamespace }>(env: T): T {
	if (!env.ATTACHMENTS && env.ATTACHMENTS_KV) {
		env.ATTACHMENTS = createKvAttachmentStore(env.ATTACHMENTS_KV);
	}
	return env;
}
