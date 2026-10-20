ALTER TABLE annotations ADD COLUMN source TEXT NOT NULL DEFAULT 'app' CHECK(source IN ('app','mcp','share'));
ALTER TABLE annotations ADD COLUMN agent_client TEXT;
UPDATE annotations SET source='share' WHERE author_id IS NOT NULL;
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Only set inside the same write transaction as remote apply. SQLite serializes
-- writers; rollback (including process failure) also rolls back this marker.
CREATE TABLE sync_remote_apply(singleton INTEGER PRIMARY KEY CHECK(singleton=1));
CREATE TRIGGER annotations_share_insert AFTER INSERT ON annotations
WHEN NOT EXISTS(SELECT 1 FROM sync_remote_apply) BEGIN
 INSERT INTO share_outbox(share_id,annotation_id,updated_at,deleted)
 SELECT id,new.id,new.updated_at,0 FROM shares
 WHERE document_id=new.document_id AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
 ON CONFLICT(share_id,annotation_id) DO UPDATE SET updated_at=excluded.updated_at,deleted=0;
END;
CREATE TRIGGER annotations_share_update AFTER UPDATE ON annotations
WHEN NOT EXISTS(SELECT 1 FROM sync_remote_apply) BEGIN
 INSERT INTO share_outbox(share_id,annotation_id,updated_at,deleted)
 SELECT id,new.id,new.updated_at,0 FROM shares
 WHERE document_id=new.document_id AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
 ON CONFLICT(share_id,annotation_id) DO UPDATE SET updated_at=excluded.updated_at,deleted=0;
END;
CREATE TRIGGER annotations_share_delete AFTER DELETE ON annotations
WHEN NOT EXISTS(SELECT 1 FROM sync_remote_apply) BEGIN
 INSERT INTO share_outbox(share_id,annotation_id,updated_at,deleted)
 SELECT id,old.id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday('now'),coalesce(julianday(old.updated_at),0)+0.001/86400)),1 FROM shares
 WHERE document_id=old.document_id AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
 ON CONFLICT(share_id,annotation_id) DO UPDATE SET updated_at=excluded.updated_at,deleted=1;
END;
-- Keep the harness for deletion too, after the annotation itself is gone.
CREATE TABLE agent_writes(
 id INTEGER PRIMARY KEY, annotation_id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('create','update','delete')),
 agent_client TEXT NOT NULL, written_at TEXT NOT NULL
);
