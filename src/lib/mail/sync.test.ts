import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	isMailChangedMessage,
	MAIL_CHANGED_MESSAGE,
	MAILBOX_DATA_DEPENDENCY,
	MAILBOX_SYNC_HOLD_MS,
	MAILBOX_SYNC_PATH,
	MAILBOX_SYNC_TICK_MS,
	mailboxSyncUrl,
	readMailboxCursor,
	shouldRefreshMailbox,
	waitForAbortable
} from './sync';
import { loadMailbox } from '../server/mailbox';
import { createTestDb, insertTestUser } from '../server/test-db';

test('mail polling holds for twenty seconds with five-second database checks', () => {
	assert.equal(MAILBOX_SYNC_HOLD_MS, 20_000);
	assert.equal(MAILBOX_SYNC_TICK_MS, 5_000);
	assert.equal(MAILBOX_SYNC_HOLD_MS / MAILBOX_SYNC_TICK_MS, 4);
});

test('mailbox loads explicitly register the mail dependency without requiring a database', async () => {
	const dependencies: string[] = [];
	const result = await loadMailbox(undefined, undefined, 'inbox', new URL('https://mail.example.test/inbox'),
		null, (...keys) => dependencies.push(...keys));
	assert.deepEqual(dependencies, [MAILBOX_DATA_DEPENDENCY]);
	assert.equal(result.mailbox.total, 0);
	await loadMailbox(undefined, undefined, 'inbox', new URL('https://mail.example.test/inbox'), null);
});

test('registered mailbox loads retain ownership and filter behavior', async () => {
	const { db, sqlite } = createTestDb();
	insertTestUser(sqlite);
	insertTestUser(sqlite, 'other');
	sqlite.query(`INSERT INTO emails (id,user_id,direction,from_addr,to_addr,subject,category)
		VALUES ('visible','user-1','inbound','sender@example.net','user-1@example.com','Synthetic','social'),
		('foreign','other','inbound','sender@example.net','other@example.com','Synthetic','social'),
		('primary','user-1','inbound','sender@example.net','user-1@example.com','Synthetic','primary')`).run();
	const dependencies: string[] = [];
	const result = await loadMailbox(db, 'user-1', 'inbox',
		new URL('https://mail.example.test/inbox?category=social'), null,
		(...keys) => dependencies.push(...keys));
	assert.deepEqual(dependencies, [MAILBOX_DATA_DEPENDENCY]);
	assert.equal(result.filters.category, 'social');
	assert.equal(result.mailbox.total, 1);
	assert.equal(result.mailbox.threads[0].latest_id, 'visible');
});

test('mailbox sync URLs carry the cursor only after the first snapshot', () => {
	assert.equal(mailboxSyncUrl(null), MAILBOX_SYNC_PATH);
	assert.equal(mailboxSyncUrl('9:41'), `${MAILBOX_SYNC_PATH}?cursor=9%3A41`);
});

test('the first cursor snapshot does not refresh, later changes do', () => {
	assert.equal(shouldRefreshMailbox(null, '0:0'), false);
	assert.equal(shouldRefreshMailbox('1:10', '1:10'), false);
	assert.equal(shouldRefreshMailbox('1:10', '2:11'), true);
});

test('cursor payloads must be non-empty strings', () => {
	assert.equal(readMailboxCursor({ cursor: '2:11' }), '2:11');
	assert.equal(readMailboxCursor({ cursor: '' }), null);
	assert.equal(readMailboxCursor({ cursor: 2 }), null);
	assert.equal(readMailboxCursor(null), null);
});

test('open tabs wake on the push worker mail-changed message', () => {
	assert.equal(isMailChangedMessage({ type: MAIL_CHANGED_MESSAGE }), true);
	assert.equal(isMailChangedMessage({ type: 'push' }), false);
	assert.equal(isMailChangedMessage('mail:changed'), false);
});

test('abortable waits resolve early when the signal fires', async () => {
	const controller = new AbortController();
	const started = Date.now();
	queueMicrotask(() => controller.abort());
	assert.equal(await waitForAbortable(5_000, controller.signal), false);
	assert.ok(Date.now() - started < 1_000);
	assert.equal(await waitForAbortable(1, new AbortController().signal), true);
});
