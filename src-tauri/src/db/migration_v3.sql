ALTER TABLE annotations ADD COLUMN author_id TEXT;
ALTER TABLE annotations ADD COLUMN author_name TEXT;
ALTER TABLE annotations ADD COLUMN share_id TEXT;
CREATE TABLE shares(
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 share_key TEXT NOT NULL, owner_token TEXT NOT NULL, url TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, last_event_at TEXT
);
CREATE INDEX shares_document ON shares(document_id);
-- Durable retries, including deletes while disconnected. Entries disappear only on acknowledgement.
CREATE TABLE share_outbox(
 share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
 annotation_id TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(share_id, annotation_id)
);
