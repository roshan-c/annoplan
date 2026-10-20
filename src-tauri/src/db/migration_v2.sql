CREATE TABLE annotations_new(
 seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink','purple')),
 quote TEXT NOT NULL CHECK(length(quote)>0), prefix TEXT NOT NULL DEFAULT '', suffix TEXT NOT NULL DEFAULT '',
 start_offset INTEGER NOT NULL CHECK(start_offset>=0), end_offset INTEGER NOT NULL CHECK(end_offset>start_offset),
 page INTEGER CHECK(page IS NULL OR page>0), rects_json TEXT, note TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO annotations_new(id, document_id, color, quote, prefix, suffix, start_offset, end_offset, page, rects_json, note, created_at, updated_at)
 SELECT id, document_id, color, quote, prefix, suffix, start_offset, end_offset, page, rects_json, note, created_at, updated_at FROM annotations;
DROP TRIGGER annotations_ai;
DROP TRIGGER annotations_ad;
DROP TRIGGER annotations_au;
DROP TABLE annotations_fts;
DROP TABLE annotations;
ALTER TABLE annotations_new RENAME TO annotations;
CREATE INDEX annotations_document ON annotations(document_id);
CREATE VIRTUAL TABLE annotations_fts USING fts5(quote, note, content='annotations', content_rowid='seq');
CREATE TRIGGER annotations_ai AFTER INSERT ON annotations BEGIN
 INSERT INTO annotations_fts(rowid,quote,note) VALUES(new.seq,new.quote,new.note);
END;
CREATE TRIGGER annotations_ad AFTER DELETE ON annotations BEGIN
 INSERT INTO annotations_fts(annotations_fts,rowid,quote,note) VALUES('delete',old.seq,old.quote,old.note);
END;
CREATE TRIGGER annotations_au AFTER UPDATE ON annotations BEGIN
 INSERT INTO annotations_fts(annotations_fts,rowid,quote,note) VALUES('delete',old.seq,old.quote,old.note);
 INSERT INTO annotations_fts(rowid,quote,note) VALUES(new.seq,new.quote,new.note);
END;
INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild');
