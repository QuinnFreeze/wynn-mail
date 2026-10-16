-- Retention is opt-in for each account. Existing read messages start their
-- grace period at migration time, rather than being immediately eligible.
ALTER TABLE users ADD COLUMN mail_retention_read_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mail_retention_read_enabled IN (0, 1));
ALTER TABLE users ADD COLUMN mail_retention_read_days INTEGER NOT NULL DEFAULT 30 CHECK (mail_retention_read_days BETWEEN 1 AND 3650);
ALTER TABLE users ADD COLUMN mail_retention_trash_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mail_retention_trash_enabled IN (0, 1));
ALTER TABLE users ADD COLUMN mail_retention_trash_days INTEGER NOT NULL DEFAULT 30 CHECK (mail_retention_trash_days BETWEEN 1 AND 3650);

ALTER TABLE emails ADD COLUMN read_at TEXT;
UPDATE emails SET read_at = datetime('now') WHERE is_read = 1;

CREATE TRIGGER emails_set_read_at_on_insert AFTER INSERT ON emails
WHEN NEW.is_read = 1
BEGIN
	UPDATE emails SET read_at = datetime('now') WHERE id = NEW.id;
END;

-- A repeated read must not postpone retention. Restoring an already-read
-- message does start a fresh grace period so it stays recoverable.
CREATE TRIGGER emails_set_read_at_on_update AFTER UPDATE OF is_read, deleted_at ON emails
WHEN OLD.is_read != NEW.is_read
	OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.is_read = 1)
BEGIN
	UPDATE emails SET read_at = CASE WHEN NEW.is_read = 1 THEN datetime('now') ELSE NULL END
	WHERE id = NEW.id;
END;

CREATE TRIGGER emails_bump_epoch_on_read_or_trash AFTER UPDATE OF is_read, deleted_at ON emails
WHEN OLD.is_read != NEW.is_read OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
	UPDATE users SET mailbox_epoch = mailbox_epoch + 1 WHERE id = NEW.user_id;
END;

CREATE INDEX idx_emails_retention_read ON emails(read_at, id)
WHERE direction = 'inbound' AND is_read = 1 AND is_starred = 0
	AND deleted_at IS NULL AND archived_at IS NULL AND spam_at IS NULL
	AND (status IS NULL OR status != 'draft');
CREATE INDEX idx_emails_retention_trash ON emails(deleted_at, id) WHERE deleted_at IS NOT NULL;

-- DB deletion and durable object cleanup are separate phases. A failed KV/R2
-- deletion stays queued for a later run; referenced shared keys are protected.
CREATE TABLE mail_storage_cleanup (
	storage_key TEXT PRIMARY KEY,
	generation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mail_storage_cleanup_created ON mail_storage_cleanup(created_at, storage_key);
CREATE INDEX idx_attachments_storage_key ON email_attachments(storage_key) WHERE storage_key IS NOT NULL;
CREATE INDEX idx_emails_raw_storage_key ON emails(raw_storage_key) WHERE raw_storage_key IS NOT NULL;
