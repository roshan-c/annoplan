CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE documents(
 id TEXT PRIMARY KEY, path TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE,
 format TEXT NOT NULL CHECK(format IN ('md','pdf','docx')), title TEXT NOT NULL,
 added_at TEXT NOT NULL, last_opened_at TEXT NOT NULL
);
CREATE TABLE annotations(
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink','purple')),
 quote TEXT NOT NULL CHECK(length(quote)>0), prefix TEXT NOT NULL DEFAULT '', suffix TEXT NOT NULL DEFAULT '',
 start_offset INTEGER NOT NULL CHECK(start_offset>=0), end_offset INTEGER NOT NULL CHECK(end_offset>start_offset),
 page INTEGER CHECK(page IS NULL OR page>0), rects_json TEXT, note TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX annotations_document ON annotations(document_id);
CREATE VIRTUAL TABLE annotations_fts USING fts5(quote, note, content='annotations', content_rowid='rowid');
CREATE TRIGGER annotations_ai AFTER INSERT ON annotations BEGIN
 INSERT INTO annotations_fts(rowid,quote,note) VALUES(new.rowid,new.quote,new.note);
END;
CREATE TRIGGER annotations_ad AFTER DELETE ON annotations BEGIN
 INSERT INTO annotations_fts(annotations_fts,rowid,quote,note) VALUES('delete',old.rowid,old.quote,old.note);
END;
CREATE TRIGGER annotations_au AFTER UPDATE ON annotations BEGIN
 INSERT INTO annotations_fts(annotations_fts,rowid,quote,note) VALUES('delete',old.rowid,old.quote,old.note);
 INSERT INTO annotations_fts(rowid,quote,note) VALUES(new.rowid,new.quote,new.note);
END;
