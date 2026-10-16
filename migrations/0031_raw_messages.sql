-- Originals live in the private ATTACHMENTS store. Nullable for historic mail
-- and messages received through providers that do not supply the original MIME.
ALTER TABLE emails ADD COLUMN raw_storage_key TEXT;
