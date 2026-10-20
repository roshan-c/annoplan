use super::*;
fn setup() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("test.db")).unwrap();
    (dir, db)
}
fn annotation(doc: &Document) -> Annotation {
    Annotation {
        source: "app".into(),
        agent_client: None,
        author_id: None,
        author_name: None,
        share_id: None,
        id: "a1".into(),
        document_id: doc.id.clone(),
        color: "yellow".into(),
        quote: "memorable passage".into(),
        prefix: "before ".into(),
        suffix: " after".into(),
        start_offset: 7,
        end_offset: 24,
        page: None,
        rects_json: None,
        note: Some("a lunar idea".into()),
        created_at: "".into(),
        updated_at: "".into(),
    }
}
#[test]
fn migration_is_durable_idempotent_and_uses_wal() {
    let (dir, db) = setup();
    assert_eq!(
        db.0.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(
        db.0.query_row("SELECT max(version) FROM schema_version", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
    let d = db.register("/one.md", "hash", "md", "One").unwrap();
    drop(db);
    let reopened = Database::open(&dir.path().join("test.db")).unwrap();
    assert_eq!(reopened.documents().unwrap()[0].id, d.id);
}
#[test]
fn insert_update_delete_keep_fts_in_sync_and_count_annotations() {
    let (_dir, db) = setup();
    let d = db.register("/one.md", "hash", "md", "One").unwrap();
    let saved = db.save(annotation(&d)).unwrap();
    assert!(!saved.created_at.is_empty());
    assert_eq!(db.annotations(&d.id).unwrap()[0].quote, "memorable passage");
    assert_eq!(db.documents().unwrap()[0].annotation_count, 1);
    assert_eq!(db.search("lunar").unwrap()[0].document.id, d.id);
    assert_eq!(db.search("memorable").unwrap().len(), 1);
    let mut edit = saved;
    edit.note = Some("solar".into());
    edit.color = "pink".into();
    let edited = db.save(edit).unwrap();
    assert_eq!(edited.color, "pink");
    assert!(db.search("lunar").unwrap().is_empty());
    assert_eq!(db.search("solar").unwrap().len(), 1);
    db.delete("a1").unwrap();
    assert!(db.search("solar").unwrap().is_empty());
    assert_eq!(db.documents().unwrap()[0].annotation_count, 0);
}
#[test]
fn moving_identical_content_preserves_identity_and_annotations() {
    let (_dir, db) = setup();
    let old = db.register("/old.md", "same-hash", "md", "Old").unwrap();
    db.save(annotation(&old)).unwrap();
    let moved = db.register("/new.md", "same-hash", "md", "New").unwrap();
    assert_eq!(old.id, moved.id);
    assert_eq!(moved.path, "/new.md");
    assert_eq!(moved.added_at, old.added_at);
    assert_eq!(db.documents().unwrap().len(), 1);
    assert_eq!(db.annotations(&moved.id).unwrap().len(), 1);
}
#[test]
fn invalid_annotations_and_unknown_documents_are_rejected() {
    let (_dir, db) = setup();
    let d = db.register("/one.md", "hash", "md", "One").unwrap();
    let mut a = annotation(&d);
    a.document_id = "missing".into();
    assert!(db.save(a).is_err());
    let mut a = annotation(&d);
    a.color = "orange".into();
    assert!(db.save(a).is_err());
    let mut a = annotation(&d);
    a.end_offset = a.start_offset;
    assert!(db.save(a).is_err());
}

// Frozen original v1 schema: independent of the migrations under test.
const V1_SCHEMA: &str = r#"CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
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
INSERT INTO schema_version VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
"#;

fn v1_database(path: &Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(V1_SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    conn.execute("INSERT INTO documents(id,path,content_hash,format,title,added_at,last_opened_at) VALUES('doc','/old.md','hash','md','Original','created','opened')", []).unwrap();
    for (id, quote, note) in [
        ("first", "amber passage", "lunar thought"),
        ("second", "violet passage", "solar thought"),
    ] {
        conn.execute("INSERT INTO annotations(id,document_id,color,quote,prefix,suffix,start_offset,end_offset,page,rects_json,note,created_at,updated_at) VALUES(?1,'doc','green',?2,'before','after',4,20,2,'[]',?3,'created','updated')", params![id,quote,note]).unwrap();
    }
}

#[test]
fn v1_upgrade_preserves_documents_annotations_and_search() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v1.db");
    v1_database(&path);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.0.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
    let doc = &db.documents().unwrap()[0];
    assert_eq!(
        (
            &*doc.id,
            &*doc.path,
            &*doc.title,
            &*doc.added_at,
            &*doc.last_opened_at,
            doc.annotation_count
        ),
        ("doc", "/old.md", "Original", "created", "opened", 2)
    );
    let rows = db.annotations("doc").unwrap();
    assert_eq!(rows.len(), 2);
    for (id, quote, note) in [
        ("first", "amber passage", "lunar thought"),
        ("second", "violet passage", "solar thought"),
    ] {
        let row = rows.iter().find(|a| a.id == id).unwrap();
        assert_eq!(row.quote, quote);
        assert_eq!(row.note.as_deref(), Some(note));
        assert_eq!(
            (
                &*row.color,
                &*row.prefix,
                &*row.suffix,
                row.start_offset,
                row.end_offset,
                row.page,
                row.rects_json.as_deref(),
                &*row.created_at,
                &*row.updated_at
            ),
            (
                "green",
                "before",
                "after",
                4,
                20,
                Some(2),
                Some("[]"),
                "created",
                "updated"
            )
        );
        for term in [quote, note] {
            let found = db.search(term).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].annotation.id, id);
        }
    }
    assert_eq!(
        db.0.pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    db.0.execute("DELETE FROM documents WHERE id='doc'", [])
        .unwrap();
    assert!(db.annotations("doc").unwrap().is_empty());
    assert!(db.search("passage").unwrap().is_empty());
}

#[test]
fn search_survives_vacuum_with_gaps() {
    let (_dir, db) = setup();
    let doc = db.register("/one.md", "hash", "md", "One").unwrap();
    for index in 0..7 {
        let mut row = annotation(&doc);
        row.id = format!("annotation-{index}");
        row.quote = format!("passage token{index}");
        row.note = Some(format!("memo{index}"));
        db.save(row).unwrap();
    }
    for index in [1, 3, 4] {
        db.delete(&format!("annotation-{index}")).unwrap();
    }
    db.0.execute_batch("VACUUM").unwrap();
    for index in 0..7 {
        for query in [format!("token{index}"), format!("memo{index}")] {
            let results = db.search(&query).unwrap();
            if [1, 3, 4].contains(&index) {
                assert!(results.is_empty());
            } else {
                assert_eq!(results.len(), 1);
                assert_eq!(results[0].annotation.id, format!("annotation-{index}"));
            }
        }
    }
}

#[test]
fn fresh_and_upgraded_databases_have_identical_schema() {
    let (_fresh_dir, fresh) = setup();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v1.db");
    v1_database(&path);
    let migrated = Database::open(&path).unwrap();
    let schema = |db: &Database| -> Vec<(String, String, Option<String>)> {
        db.0.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
            .unwrap()
            .query_map([], |r| {
                Ok((
                    r.get("type")?,
                    r.get("name")?,
                    r.get::<_, Option<String>>("sql")?
                        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")),
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(schema(&fresh), schema(&migrated));
}

#[test]
fn newer_database_version_is_rejected_without_changing_schema() {
    let (dir, db) = setup();
    db.0.pragma_update(None, "user_version", 5).unwrap();
    drop(db);
    let path = dir.path().join("test.db");
    assert!(matches!(
        Database::open(&path),
        Err(rusqlite::Error::InvalidQuery)
    ));
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        conn.query_row("SELECT max(version) FROM schema_version", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
}

#[test]
fn v2_upgrade_keeps_every_row_and_adds_nullable_authorship() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v2.db");
    v1_database(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(include_str!("migration_v2.sql"))
        .unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    let before: String = conn.query_row("SELECT group_concat(id || quote || note || created_at || updated_at) FROM annotations ORDER BY id",[],|r|r.get(0)).unwrap();
    drop(conn);
    let db = Database::open(&path).unwrap();
    let after: String = db.0.query_row("SELECT group_concat(id || quote || note || created_at || updated_at) FROM annotations ORDER BY id",[],|r|r.get(0)).unwrap();
    assert_eq!(before, after);
    assert!(db
        .annotations("doc")
        .unwrap()
        .iter()
        .all(|a| a.author_id.is_none() && a.author_name.is_none() && a.share_id.is_none()));
    assert_eq!(db.documents().unwrap().len(), 1);
    assert_eq!(db.search("lunar").unwrap().len(), 1);
}

#[test]
fn shares_and_remote_import_preserve_attribution_timestamps_and_ownership() {
    let (_dir, db) = setup();
    let doc = db.register("/one.md", "hash", "md", "One").unwrap();
    let mut s = Share {
        id: "s".into(),
        document_id: doc.id.clone(),
        share_key: "key".into(),
        owner_token: "token".into(),
        url: "url".into(),
        expires_at: "expires".into(),
        created_at: "created".into(),
        revoked_at: None,
        last_event_at: None,
    };
    db.save_share(s.clone()).unwrap();
    assert_eq!(db.shares(&doc.id).unwrap()[0].owner_token, "token");
    let mut a = annotation(&doc);
    a.author_id = Some("sam".into());
    a.author_name = Some("Sam".into());
    a.share_id = Some("s".into());
    a.created_at = "2026-01-01".into();
    a.updated_at = "2026-01-02".into();
    db.import_annotation(a.clone()).unwrap();
    assert_eq!(
        db.search("lunar").unwrap()[0]
            .annotation
            .author_name
            .as_deref(),
        Some("Sam")
    );
    a.note = Some("old".into());
    a.updated_at = "2026-01-01".into();
    db.import_annotation(a.clone()).unwrap();
    assert_eq!(
        db.annotations(&doc.id).unwrap()[0].note.as_deref(),
        Some("a lunar idea")
    );
    a.author_id = None;
    a.updated_at = "2026-01-03".into();
    db.import_annotation(a).unwrap();
    assert_eq!(
        db.annotations(&doc.id).unwrap()[0].author_id.as_deref(),
        Some("sam")
    );
    s.revoked_at = Some("revoked".into());
    db.save_share(s).unwrap();
    assert_eq!(
        db.shares(&doc.id).unwrap()[0].revoked_at.as_deref(),
        Some("revoked")
    );
    assert_eq!(db.annotations(&doc.id).unwrap().len(), 1);
}

#[test]
fn outbox_retries_edits_and_deletes_and_acknowledges_only_matching_revision() {
    let (_dir, db) = setup();
    let doc = db.register("/one.md", "hash", "md", "One").unwrap();
    let a = db.save(annotation(&doc)).unwrap();
    let share = Share {
        id: "s".into(),
        document_id: doc.id.clone(),
        share_key: "key".into(),
        owner_token: "token".into(),
        url: "url".into(),
        expires_at: "2099-01-01T00:00:00Z".into(),
        created_at: now(),
        revoked_at: None,
        last_event_at: None,
    };
    db.save_share(share).unwrap();
    assert_eq!(db.outbox("s").unwrap().len(), 1);
    let old = db.outbox("s").unwrap()[0].updated_at.clone();
    let mut edit = a;
    edit.note = Some("edit while disconnected".into());
    db.save(edit).unwrap();
    db.acknowledge("s", "a1", &old).unwrap();
    assert_eq!(db.outbox("s").unwrap().len(), 1);
    let updated = db.outbox("s").unwrap()[0].updated_at.clone();
    db.acknowledge("s", "a1", &updated).unwrap();
    assert!(db.outbox("s").unwrap().is_empty());
    db.delete("a1").unwrap();
    assert!(db.outbox("s").unwrap()[0].deleted);
    let mut stale = annotation(&doc);
    stale.created_at = now();
    stale.updated_at = "2099-01-01T00:00:00Z".into();
    db.import_annotation(stale).unwrap();
    assert!(
        db.annotations(&doc.id).unwrap().is_empty(),
        "catch-up must not resurrect a pending offline delete"
    );
    let mut remote = annotation(&doc);
    remote.id = "remote".into();
    remote.author_id = Some("sam".into());
    remote.author_name = Some("Sam".into());
    remote.share_id = Some("s".into());
    remote.created_at = now();
    remote.updated_at = now();
    db.import_annotation(remote.clone()).unwrap();
    assert!(db.save(remote).is_err());
    assert!(db.delete("remote").is_err());
    db.remote_delete("remote", "other", Some("sam".into()))
        .unwrap();
    assert_eq!(db.annotations(&doc.id).unwrap().len(), 1);
    db.remote_delete("remote", "s", Some("sam".into())).unwrap();
    assert!(db.annotations(&doc.id).unwrap().is_empty());
}

#[test]
fn v3_upgrade_is_lossless_and_backfills_sources_without_touching_outbox() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v3.db");
    v1_database(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(include_str!("migration_v2.sql"))
        .unwrap();
    conn.execute_batch(include_str!("migration_v3.sql"))
        .unwrap();
    conn.pragma_update(None, "user_version", 3).unwrap();
    conn.execute_batch("UPDATE annotations SET author_id='sam',author_name='Sam',share_id='s' WHERE id='second'; INSERT INTO shares VALUES('s','doc','key','token','url','2099-01-01','created',NULL,'cursor'); INSERT INTO share_outbox VALUES('s','deleted-row','revision',1);").unwrap();
    let rows = |c: &Connection| -> Vec<Vec<rusqlite::types::Value>> {
        c.prepare("SELECT seq,id,document_id,color,quote,prefix,suffix,start_offset,end_offset,page,rects_json,note,created_at,updated_at,author_id,author_name,share_id FROM annotations ORDER BY seq").unwrap().query_map([], |r| (0..17).map(|i| r.get(i)).collect()).unwrap().collect::<Result<_,_>>().unwrap()
    };
    let before = rows(&conn);
    drop(conn);
    let db = Database::open(&path).unwrap();
    assert_eq!(rows(&db.0), before);
    assert_eq!(
        db.annotations("doc")
            .unwrap()
            .iter()
            .map(|a| a.source.as_str())
            .collect::<Vec<_>>(),
        vec!["app", "share"]
    );
    assert_eq!(db.outbox("s").unwrap()[0].id, "deleted-row");
    assert!(db.outbox("s").unwrap()[0].deleted);
    assert_eq!(
        db.shares("doc").unwrap()[0].last_event_at.as_deref(),
        Some("cursor")
    );
    assert_eq!(db.search("lunar").unwrap().len(), 1);
}

#[test]
fn triggers_cover_external_writers_and_remote_apply_never_echoes_even_owner_rows() {
    let (dir, db) = setup();
    let doc = db.register("/one.md", "hash", "md", "One").unwrap();
    for (id, expires, revoked) in [
        ("active", "2099-01-01", None),
        ("expired", "2000-01-01", None),
        ("revoked", "2099-01-01", Some("revoked")),
    ] {
        db.save_share(Share {
            id: id.into(),
            document_id: doc.id.clone(),
            share_key: "key".into(),
            owner_token: "token".into(),
            url: "url".into(),
            expires_at: expires.into(),
            created_at: now(),
            revoked_at: revoked.map(String::from),
            last_event_at: None,
        })
        .unwrap();
    }
    // A second connection has no Rust enqueue helper: SQLite is the contract.
    let external = Connection::open(dir.path().join("test.db")).unwrap();
    external.execute("INSERT INTO annotations(id,document_id,color,quote,start_offset,end_offset,created_at,updated_at,source,agent_client) VALUES('agent',?1,'yellow','quote',0,5,'created','revision','mcp','harness 1')", [&doc.id]).unwrap();
    assert_eq!(db.outbox("active").unwrap().len(), 1);
    assert!(db.outbox("expired").unwrap().is_empty());
    assert!(db.outbox("revoked").unwrap().is_empty());
    external
        .execute(
            "UPDATE annotations SET note='changed',updated_at='next' WHERE id='agent'",
            [],
        )
        .unwrap();
    db.acknowledge("active", "agent", "revision").unwrap();
    assert_eq!(db.outbox("active").unwrap()[0].updated_at, "next");
    db.acknowledge("active", "agent", "next").unwrap();
    let mut owner_echo = annotation(&doc);
    owner_echo.id = "agent".into();
    owner_echo.source = "mcp".into();
    owner_echo.agent_client = Some("harness 2".into());
    owner_echo.updated_at = "2099-01-01".into();
    // Set a real older timestamp to exercise the remote conflict predicate.
    external
        .execute(
            "UPDATE annotations SET updated_at='2020-01-01' WHERE id='agent'",
            [],
        )
        .unwrap();
    db.acknowledge("active", "agent", "2020-01-01").unwrap();
    db.import_annotation(owner_echo).unwrap();
    assert!(db.outbox("active").unwrap().is_empty());
    db.remote_delete("agent", "active", None).unwrap();
    assert!(db.outbox("active").unwrap().is_empty());
    assert!(db.annotations(&doc.id).unwrap().is_empty());
    // A failed import must roll back the marker, so the next local write queues.
    let mut invalid = annotation(&doc);
    invalid.color = "invalid".into();
    assert!(db.import_annotation(invalid).is_err());
    db.save(annotation(&doc)).unwrap();
    assert_eq!(db.outbox("active").unwrap().len(), 1);
    external
        .execute("DELETE FROM annotations WHERE id='a1'", [])
        .unwrap();
    assert!(db.outbox("active").unwrap()[0].deleted);
}

#[test]
fn agent_labels_follow_settings_and_owner_can_edit_delete_and_reanchor_agent_rows() {
    let (_dir, db) = setup();
    let doc = db.register("/one.md", "hash", "md", "One").unwrap();
    let mut a = annotation(&doc);
    a.source = "mcp".into();
    a.agent_client = Some("harness 1".into());
    db.save(a).unwrap();
    db.set_owner_name("Ada").unwrap();
    assert_eq!(
        db.annotations(&doc.id).unwrap()[0].author_name.as_deref(),
        Some("Ada's agent")
    );
    db.set_owner_name("Alex").unwrap();
    assert_eq!(
        db.search("lunar").unwrap()[0]
            .annotation
            .author_name
            .as_deref(),
        Some("Alex's agent")
    );
    let mut a = db.annotations(&doc.id).unwrap().remove(0);
    a.note = Some("edited".into());
    assert_eq!(
        db.save(a).unwrap().agent_client.as_deref(),
        Some("harness 1")
    );
    db.reanchor("a1", 15, 32).unwrap();
    assert_eq!(db.annotations(&doc.id).unwrap()[0].start_offset, 15);
    db.delete("a1").unwrap();
    assert!(db.annotations(&doc.id).unwrap().is_empty());
}
