import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

/** Internal SQL only. The predicate is rechecked inside one atomic D1 batch,
 * before any stored object is removed, so a concurrent restore can still win. */
export async function deleteMailMatching(
	db: D1Database,
	_bucket: R2Bucket | undefined,
	options: { where: string; bindings: unknown[]; limit?: number }
): Promise<number> {
	const limit = options.limit === undefined ? '' : ' LIMIT ?';
	const bindings = [...options.bindings];
	if (options.limit !== undefined) {
		if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
			throw new Error('Invalid mail deletion batch size');
		}
		bindings.push(options.limit);
	}
	const selection = `SELECT e.id FROM emails e WHERE ${options.where} ORDER BY e.id${limit}`;
	// Child deletion does not change this predicate. All five statements share
	// one transaction; any failure rolls back the queue and every deleted row.
	const results = await db.batch([
		db.prepare(`INSERT OR IGNORE INTO mail_storage_cleanup (storage_key)
			SELECT raw_storage_key FROM emails WHERE id IN (${selection})
			AND raw_storage_key IS NOT NULL`).bind(...bindings),
		db.prepare(`INSERT OR IGNORE INTO mail_storage_cleanup (storage_key)
			SELECT storage_key FROM email_attachments WHERE email_id IN (${selection})
			AND storage_key IS NOT NULL`).bind(...bindings),
		db.prepare(`DELETE FROM email_attachments WHERE email_id IN (${selection})`).bind(...bindings),
		db.prepare(`DELETE FROM email_labels WHERE email_id IN (${selection})`).bind(...bindings),
		db.prepare(`DELETE FROM emails WHERE id IN (${selection}) RETURNING id`).bind(...bindings)
	]);
	return results.at(-1)?.results?.length ?? 0;
}

/** Retryable, bounded storage cleanup. Missing objects are safe to delete again.
 * Keys still referenced by another message are retained until that mail is gone.
 * A conditional generation acknowledgement preserves work requeued during I/O. */
export async function drainMailStorageCleanup(
	db: D1Database,
	bucket: R2Bucket | undefined,
	limit = 20
): Promise<{ deleted: number; failed: number }> {
	if (!bucket) return { deleted: 0, failed: 0 };
	if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error('Invalid cleanup batch size');
	const { results } = await db.prepare(`SELECT q.storage_key, q.generation FROM mail_storage_cleanup q
		WHERE NOT EXISTS (SELECT 1 FROM emails e WHERE e.raw_storage_key = q.storage_key)
		AND NOT EXISTS (SELECT 1 FROM email_attachments a WHERE a.storage_key = q.storage_key)
		ORDER BY q.created_at, q.storage_key LIMIT ?`).bind(limit).all<{ storage_key: string; generation: string }>();
	const outcomes = await Promise.allSettled(results.map(async (entry) => {
		await bucket.delete(entry.storage_key);
		return entry;
	}));
	const deleted = outcomes.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
	if (deleted.length) {
		await db.prepare(`DELETE FROM mail_storage_cleanup WHERE ${deleted.map(() => '(storage_key = ? AND generation = ?)').join(' OR ')}`)
			.bind(...deleted.flatMap((entry) => [entry.storage_key, entry.generation])).run();
	}
	return { deleted: deleted.length, failed: outcomes.length - deleted.length };
}
