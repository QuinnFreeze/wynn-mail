import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { createTestDb, insertTestUser } from './test-db';
import { deleteMailMatching, drainMailStorageCleanup } from './mail-deletion';
import { emptyTrash } from './mail-store';

function fixture(count = 1) {
	const f = createTestDb();
	insertTestUser(f.sqlite);
	insertTestUser(f.sqlite, 'other');
	for (let i = 0; i < count; i++) {
		f.sqlite.query(`INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,deleted_at,raw_storage_key)
			VALUES (?, 'user-1','inbound','sender@example.net','recipient@example.com','Synthetic',datetime('now'),?)`)
			.run(`mail-${i}`, `raw/${i}`);
		f.sqlite.query(`INSERT INTO email_attachments (id,email_id,filename,content_type,size_bytes,content_base64,storage_key)
			VALUES (?,?,'test.txt','text/plain',1,'',?)`).run(`file-${i}`,`mail-${i}`,`file/${i}`);
	}
	return f;
}

test('empty trash deletes more than the D1 binding limit atomically and only the current user trash', async () => {
	const { db, sqlite } = fixture(125);
	sqlite.query(`INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,deleted_at)
		VALUES ('foreign','other','inbound','a@example.net','b@example.com','Foreign',datetime('now')),
		('inbox','user-1','inbound','a@example.net','b@example.com','Inbox',NULL)`).run();
	sqlite.exec('PRAGMA foreign_keys = OFF');
	assert.equal(await emptyTrash(db, undefined, 'user-1'), 125);
	assert.deepEqual(sqlite.query('SELECT id FROM emails ORDER BY id').all(), [{ id: 'foreign' }, { id: 'inbox' }]);
	assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM email_attachments').all()[0].n, 0);
	assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM mail_storage_cleanup').all()[0].n, 250);
	assert.equal(await emptyTrash(db, undefined, 'user-1'), 0);
});

test('a restore committed before the atomic batch wins without removing any stored objects', async () => {
	const { db, sqlite } = fixture();
	const racingDb = { prepare: db.prepare.bind(db), async batch(statements: Parameters<D1Database['batch']>[0]) {
		sqlite.query("UPDATE emails SET deleted_at = NULL WHERE id = 'mail-0'").run();
		return db.batch(statements);
	} } as D1Database;
	assert.equal(await emptyTrash(racingDb, undefined, 'user-1'), 0);
	assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM email_attachments').all()[0].n, 1);
	assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM mail_storage_cleanup').all()[0].n, 0);
});

test('an interrupted database batch rolls back queue, child rows and mail together', async () => {
	const { db, sqlite } = fixture();
	sqlite.exec(`CREATE TRIGGER block_mail_delete BEFORE DELETE ON emails BEGIN SELECT RAISE(ABORT, 'Synthetic failure'); END;`);
	await assert.rejects(deleteMailMatching(db, undefined, { where: 'e.user_id = ?', bindings: ['user-1'] }), /Synthetic failure/);
	assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM emails').all()[0].n, 1);
	assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM email_attachments').all()[0].n, 1);
	assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM mail_storage_cleanup').all()[0].n, 0);
});

test('bounded storage cleanup retries failures and preserves objects referenced by live mail', async () => {
	const { db, sqlite } = fixture(3);
	await deleteMailMatching(db, undefined, { where: 'e.id != ?', bindings: ['mail-2'], limit: 1 });
	sqlite.query("INSERT INTO mail_storage_cleanup(storage_key) VALUES ('raw/2')").run();
	const deleted: string[] = [];
	let fail = true;
	const bucket = { async delete(key: string) { if (fail) throw new Error('offline'); deleted.push(key); } } as unknown as R2Bucket;
	assert.deepEqual(await drainMailStorageCleanup(db, bucket, 1), { deleted: 0, failed: 1 });
	fail = false;
	assert.deepEqual(await drainMailStorageCleanup(db, bucket, 1), { deleted: 1, failed: 0 });
	assert.equal(deleted.length, 1);
	assert.equal(deleted.includes('raw/2'), false);
	assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM mail_storage_cleanup').all()[0].n, 2);
	assert.deepEqual(await drainMailStorageCleanup(db, undefined), { deleted: 0, failed: 0 });
});


test('a stale overlapping cleanup acknowledgement cannot consume a later requeue', async () => {
	const { db, sqlite } = fixture();
	await deleteMailMatching(db, undefined, { where: 'e.id = ?', bindings: ['mail-0'] });
	let release!: () => void;
	let entered!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const started = new Promise<void>((resolve) => { entered = resolve; });
	let calls = 0;
	const bucket = { async delete() {
		if (++calls === 1) { entered(); await blocked; }
	} } as unknown as R2Bucket;
	const first = drainMailStorageCleanup(db, bucket, 1);
	await started;
	const original = sqlite.query('SELECT storage_key, generation FROM mail_storage_cleanup ORDER BY storage_key LIMIT 1').all()[0];
	await drainMailStorageCleanup(db, bucket, 1);
	sqlite.query('INSERT INTO mail_storage_cleanup(storage_key) VALUES (?)').run(original.storage_key);
	const next = sqlite.query('SELECT generation FROM mail_storage_cleanup WHERE storage_key=?').all(original.storage_key)[0].generation;
	assert.notEqual(next, original.generation);
	release();
	await first;
	assert.deepEqual(sqlite.query('SELECT generation FROM mail_storage_cleanup WHERE storage_key=?').all(original.storage_key), [{ generation: next }]);
	await drainMailStorageCleanup(db, bucket);
	assert.equal(sqlite.query('SELECT COUNT(*) AS n FROM mail_storage_cleanup').all()[0].n, 0);
});
