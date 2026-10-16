import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { deleteMailMatching } from './mail-deletion';

export type MailRetentionSettings = {
	readEnabled: boolean;
	readDays: number;
	trashEnabled: boolean;
	trashDays: number;
};

type SettingsRow = {
	mail_retention_read_enabled: number;
	mail_retention_read_days: number;
	mail_retention_trash_enabled: number;
	mail_retention_trash_days: number;
};

export async function getMailRetentionSettings(db: D1Database, userId: string): Promise<MailRetentionSettings | null> {
	const row = await db.prepare(`SELECT mail_retention_read_enabled, mail_retention_read_days,
		mail_retention_trash_enabled, mail_retention_trash_days FROM users WHERE id = ?`)
		.bind(userId).first<SettingsRow>();
	return row ? {
		readEnabled: row.mail_retention_read_enabled === 1,
		readDays: row.mail_retention_read_days,
		trashEnabled: row.mail_retention_trash_enabled === 1,
		trashDays: row.mail_retention_trash_days
	} : null;
}

export async function setMailRetentionSettings(db: D1Database, userId: string, settings: MailRetentionSettings): Promise<boolean> {
	const result = await db.prepare(`UPDATE users SET mail_retention_read_enabled = ?, mail_retention_read_days = ?,
		mail_retention_trash_enabled = ?, mail_retention_trash_days = ? WHERE id = ?`)
		.bind(Number(settings.readEnabled), settings.readDays, Number(settings.trashEnabled), settings.trashDays, userId).run();
	return result.meta.changes === 1;
}

/** One bounded run. SQL rechecks the account's current policy and message flags
 * when mutating rows; no stale JS candidate list can delete a restored message.
 * Storage cleanup is drained separately by the scheduled worker. */
export async function runMailRetention(
	db: D1Database,
	bucket: R2Bucket | undefined,
	scheduledTime: number = Date.now()
): Promise<{ trashed: number; deleted: number }> {
	if (!Number.isFinite(scheduledTime)) throw new Error('Invalid retention time');
	const now = new Date(scheduledTime).toISOString();
	const deleted = await deleteMailMatching(db, bucket, {
		where: `e.deleted_at IS NOT NULL AND e.deleted_at <= datetime(?, '-1 day')
			AND EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id
				AND u.mail_retention_trash_enabled = 1
				AND e.deleted_at <= datetime(?, '-' || u.mail_retention_trash_days || ' days'))`,
		bindings: [now, now],
		limit: 80
	});

	const eligibleRead = `e.direction = 'inbound' AND e.is_read = 1 AND e.is_starred = 0
		AND e.deleted_at IS NULL AND e.archived_at IS NULL AND e.spam_at IS NULL
		AND (e.status IS NULL OR e.status != 'draft')
		AND e.read_at IS NOT NULL AND e.read_at <= datetime(?, '-1 day')
		AND EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id
			AND u.mail_retention_read_enabled = 1
			AND e.read_at <= datetime(?, '-' || u.mail_retention_read_days || ' days'))`;
	const result = await db.prepare(`UPDATE emails AS e SET deleted_at = datetime(?)
		WHERE e.id IN (SELECT e.id FROM emails e WHERE ${eligibleRead} ORDER BY e.read_at, e.id LIMIT 200)
		AND ${eligibleRead} RETURNING id`).bind(now, now, now, now, now).all<{ id: string }>();
	return { trashed: result.results.length, deleted };
}
