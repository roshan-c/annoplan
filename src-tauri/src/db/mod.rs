use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Document {
    pub id: String,
    pub path: String,
    pub content_hash: String,
    pub format: String,
    pub title: String,
    pub added_at: String,
    pub last_opened_at: String,
    pub annotation_count: i64,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Annotation {
    #[serde(default = "app_source")]
    pub source: String,
    #[serde(default)]
    pub agent_client: Option<String>,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub share_id: Option<String>,
    pub id: String,
    pub document_id: String,
    pub color: String,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    pub start_offset: i64,
    pub end_offset: i64,
    pub page: Option<i64>,
    pub rects_json: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Share {
    pub id: String,
    pub document_id: String,
    pub share_key: String,
    pub owner_token: String,
    pub url: String,
    pub expires_at: String,
    pub created_at: String,
    pub revoked_at: Option<String>,
    pub last_event_at: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct Pending {
    pub id: String,
    pub updated_at: String,
    pub deleted: bool,
}
#[derive(Serialize)]
pub struct SearchResult {
    pub annotation: Annotation,
    pub document: Document,
}

fn app_source() -> String {
    "app".into()
}

const MIGRATIONS: &[&str] = &[
    include_str!("migration.sql"),
    include_str!("migration_v2.sql"),
    include_str!("migration_v3.sql"),
    include_str!("migration_v4.sql"),
];
const DOCUMENT_COLUMNS: &str =
    "d.id, d.path, d.content_hash, d.format, d.title, d.added_at, d.last_opened_at";
const RAW_ANNOTATION_COLUMNS: &str = "id, document_id, color, quote, prefix, suffix, start_offset, end_offset, page, rects_json, note, created_at, updated_at, author_id, author_name, share_id, source, agent_client";
const ANNOTATION_COLUMNS: &str = "id, document_id, color, quote, prefix, suffix, start_offset, end_offset, page, rects_json, note, created_at, updated_at, author_id, CASE WHEN source='mcp' THEN coalesce((SELECT value FROM settings WHERE key='owner_name'),'Owner') || char(39) || 's agent' ELSE author_name END AS author_name, share_id, source, agent_client";

pub struct Database(pub Connection);
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn doc_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Document> {
    Ok(Document {
        id: r.get("id")?,
        path: r.get("path")?,
        content_hash: r.get("content_hash")?,
        format: r.get("format")?,
        title: r.get("title")?,
        added_at: r.get("added_at")?,
        last_opened_at: r.get("last_opened_at")?,
        annotation_count: r.get("annotation_count")?,
    })
}
fn ann_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        source: r.get("source")?,
        agent_client: r.get("agent_client")?,
        author_id: r.get("author_id")?,
        author_name: r.get("author_name")?,
        share_id: r.get("share_id")?,
        id: r.get("id")?,
        document_id: r.get("document_id")?,
        color: r.get("color")?,
        quote: r.get("quote")?,
        prefix: r.get("prefix")?,
        suffix: r.get("suffix")?,
        start_offset: r.get("start_offset")?,
        end_offset: r.get("end_offset")?,
        page: r.get("page")?,
        rects_json: r.get("rects_json")?,
        note: r.get("note")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}
impl Database {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > MIGRATIONS.len() as i64 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        // SQLite's table-rebuild procedure requires this outside the transaction.
        conn.pragma_update(None, "foreign_keys", false)?;
        let migrated = (|| -> rusqlite::Result<()> {
            for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
                let tx = conn.transaction()?;
                tx.execute_batch(sql)?;
                let next_version = (index + 1) as i64;
                tx.pragma_update(None, "user_version", next_version)?;
                tx.execute(
                    "INSERT INTO schema_version(version, applied_at) VALUES(?1, ?2)",
                    params![next_version, now()],
                )?;
                if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                tx.commit()?;
            }
            Ok(())
        })();
        conn.pragma_update(None, "foreign_keys", true)?;
        migrated?;
        Ok(Self(conn))
    }
    pub fn register(
        &self,
        path: &str,
        hash: &str,
        format: &str,
        title: &str,
    ) -> rusqlite::Result<Document> {
        self.0.execute("INSERT INTO documents(id,path,content_hash,format,title,added_at,last_opened_at) VALUES(?1,?2,?3,?4,?5,?6,?6) ON CONFLICT(content_hash) DO UPDATE SET path=excluded.path,title=excluded.title,last_opened_at=excluded.last_opened_at", params![uuid::Uuid::new_v4().to_string(),path,hash,format,title,now()])?;
        self.0.query_row(&format!("SELECT {DOCUMENT_COLUMNS}, (SELECT count(*) FROM annotations WHERE document_id=d.id) AS annotation_count FROM documents d WHERE content_hash=?1"),[hash],doc_row)
    }
    pub fn documents(&self) -> rusqlite::Result<Vec<Document>> {
        self.0.prepare(&format!("SELECT {DOCUMENT_COLUMNS}, (SELECT count(*) FROM annotations WHERE document_id=d.id) AS annotation_count FROM documents d ORDER BY last_opened_at DESC"))?.query_map([],doc_row)?.collect()
    }
    pub fn annotations(&self, document_id: &str) -> rusqlite::Result<Vec<Annotation>> {
        self.0
            .prepare(
                &format!("SELECT {ANNOTATION_COLUMNS} FROM annotations WHERE document_id=?1 ORDER BY start_offset,created_at"),
            )?
            .query_map([document_id], ann_row)?
            .collect()
    }
    pub fn save(&self, mut a: Annotation) -> rusqlite::Result<Annotation> {
        if a.author_id.is_some() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let tx = self.0.unchecked_transaction()?;
        let remote: Option<Option<String>> = self
            .0
            .query_row(
                "SELECT author_id FROM annotations WHERE id=?1",
                [&a.id],
                |r| r.get(0),
            )
            .optional()?;
        if remote.flatten().is_some() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        // The database owns timestamps; edits cannot move annotations between documents.
        let existing: Option<(String, String)> = self
            .0
            .query_row(
                "SELECT document_id,created_at FROM annotations WHERE id=?1",
                [&a.id],
                |r| Ok((r.get("document_id")?, r.get("created_at")?)),
            )
            .optional()?;
        if let Some((doc, created)) = existing {
            if doc != a.document_id {
                return Err(rusqlite::Error::InvalidQuery);
            }
            a.created_at = created;
        } else {
            a.created_at = now();
        }
        a.updated_at = now();
        self.0.execute(&format!("INSERT INTO annotations({RAW_ANNOTATION_COLUMNS}) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18) ON CONFLICT(id) DO UPDATE SET color=excluded.color,note=excluded.note,updated_at=excluded.updated_at"),params![a.id,a.document_id,a.color,a.quote,a.prefix,a.suffix,a.start_offset,a.end_offset,a.page,a.rects_json,a.note,a.created_at,a.updated_at,a.author_id,a.author_name,a.share_id,a.source,a.agent_client])?;
        let saved = self.0.query_row(
            &format!("SELECT {ANNOTATION_COLUMNS} FROM annotations WHERE id=?1"),
            [&a.id],
            ann_row,
        )?;
        tx.commit()?;
        Ok(saved)
    }
    pub fn delete(&self, id: &str) -> rusqlite::Result<()> {
        let tx = self.0.unchecked_transaction()?;
        let existing: Option<(String, Option<String>)> = self
            .0
            .query_row(
                "SELECT document_id,author_id FROM annotations WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((_doc, author)) = existing {
            if author.is_some() {
                return Err(rusqlite::Error::InvalidQuery);
            }
            self.0
                .execute("DELETE FROM annotations WHERE id=?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn remote_delete(
        &self,
        id: &str,
        share_id: &str,
        author_id: Option<String>,
    ) -> rusqlite::Result<()> {
        let tx = self.0.unchecked_transaction()?;
        self.0
            .execute("INSERT INTO sync_remote_apply VALUES(1)", [])?;
        self.0.execute("DELETE FROM annotations WHERE id=?1 AND author_id IS ?2 AND (share_id=?3 OR (?2 IS NULL AND document_id=(SELECT document_id FROM shares WHERE id=?3))) AND NOT EXISTS(SELECT 1 FROM share_outbox WHERE annotation_id=?1)",params![id,author_id,share_id])?;
        self.0.execute("DELETE FROM sync_remote_apply", [])?;
        tx.commit()?;
        Ok(())
    }
    pub fn outbox(&self, share_id: &str) -> rusqlite::Result<Vec<Pending>> {
        self.0.prepare("SELECT annotation_id,updated_at,deleted FROM share_outbox WHERE share_id=?1 ORDER BY updated_at")?.query_map([share_id],|r|Ok(Pending {id:r.get(0)?,updated_at:r.get(1)?,deleted:r.get(2)?}))?.collect()
    }
    pub fn acknowledge(&self, share_id: &str, id: &str, updated_at: &str) -> rusqlite::Result<()> {
        self.0.execute(
            "DELETE FROM share_outbox WHERE share_id=?1 AND annotation_id=?2 AND updated_at=?3",
            params![share_id, id, updated_at],
        )?;
        Ok(())
    }
    pub fn shares(&self, document_id: &str) -> rusqlite::Result<Vec<Share>> {
        self.0
            .prepare("SELECT * FROM shares WHERE document_id=?1 ORDER BY created_at DESC")?
            .query_map([document_id], |r| {
                Ok(Share {
                    id: r.get("id")?,
                    document_id: r.get("document_id")?,
                    share_key: r.get("share_key")?,
                    owner_token: r.get("owner_token")?,
                    url: r.get("url")?,
                    expires_at: r.get("expires_at")?,
                    created_at: r.get("created_at")?,
                    revoked_at: r.get("revoked_at")?,
                    last_event_at: r.get("last_event_at")?,
                })
            })?
            .collect()
    }
    pub fn save_share(&self, s: Share) -> rusqlite::Result<()> {
        let tx = self.0.unchecked_transaction()?;
        let fresh = !self
            .0
            .prepare("SELECT 1 FROM shares WHERE id=?1")?
            .exists([&s.id])?;
        self.0.execute("INSERT INTO shares VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET revoked_at=excluded.revoked_at,last_event_at=excluded.last_event_at",params![s.id,s.document_id,s.share_key,s.owner_token,s.url,s.expires_at,s.created_at,s.revoked_at,s.last_event_at])?;
        if fresh {
            self.0.execute("INSERT INTO share_outbox(share_id,annotation_id,updated_at,deleted) SELECT ?1,id,updated_at,0 FROM annotations WHERE document_id=?2",params![s.id,s.document_id])?;
        }
        tx.commit()?;
        Ok(())
    }
    /// Sync import preserves server timestamps, ownership and selectors. Never steals a local UUID.
    pub fn import_annotation(&self, mut a: Annotation) -> rusqlite::Result<()> {
        if a.author_id.is_some() {
            a.source = "share".into();
            a.agent_client = None;
        }
        let tx = self.0.unchecked_transaction()?;
        self.0
            .execute("INSERT INTO sync_remote_apply VALUES(1)", [])?;
        self.0.execute(&format!("INSERT INTO annotations({RAW_ANNOTATION_COLUMNS}) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18 WHERE NOT EXISTS(SELECT 1 FROM share_outbox WHERE annotation_id=?1 AND deleted=1) ON CONFLICT(id) DO UPDATE SET color=excluded.color,note=excluded.note,updated_at=excluded.updated_at,agent_client=excluded.agent_client WHERE annotations.document_id=excluded.document_id AND annotations.author_id IS excluded.author_id AND (annotations.share_id IS excluded.share_id OR excluded.author_id IS NULL) AND julianday(annotations.updated_at)<julianday(excluded.updated_at) AND NOT EXISTS(SELECT 1 FROM share_outbox WHERE annotation_id=excluded.id)"),params![a.id,a.document_id,a.color,a.quote,a.prefix,a.suffix,a.start_offset,a.end_offset,a.page,a.rects_json,a.note,a.created_at,a.updated_at,a.author_id,a.author_name,a.share_id,a.source,a.agent_client])?;
        self.0.execute("DELETE FROM sync_remote_apply", [])?;
        tx.commit()?;
        Ok(())
    }
    pub fn owner_name(&self) -> rusqlite::Result<String> {
        self.0
            .query_row(
                "SELECT value FROM settings WHERE key='owner_name'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map(|v| v.unwrap_or_else(|| "Owner".into()))
    }
    pub fn set_owner_name(&self, name: &str) -> rusqlite::Result<()> {
        self.0.execute("INSERT INTO settings VALUES('owner_name',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [name])?;
        Ok(())
    }
    pub fn reanchor(&self, id: &str, start: i64, end: i64) -> rusqlite::Result<()> {
        self.0.execute("UPDATE annotations SET start_offset=?2,end_offset=?3,updated_at=?4 WHERE id=?1 AND author_id IS NULL AND (start_offset<>?2 OR end_offset<>?3)", params![id,start,end,now()])?;
        Ok(())
    }
    pub fn search(&self, query: &str) -> rusqlite::Result<Vec<SearchResult>> {
        // Literal terms keep punctuation and FTS operators from becoming query syntax.
        let query = query
            .split_whitespace()
            .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        if query.is_empty() {
            return Ok(vec![]);
        }
        let anns: Vec<Annotation> = self.0.prepare(&format!("SELECT {ANNOTATION_COLUMNS} FROM annotations a JOIN annotations_fts f ON f.rowid=a.seq WHERE annotations_fts MATCH ?1 ORDER BY rank LIMIT 200", ANNOTATION_COLUMNS = RAW_ANNOTATION_COLUMNS.split(", ").map(|column| if column == "author_name" { "CASE WHEN a.source='mcp' THEN coalesce((SELECT value FROM settings WHERE key='owner_name'),'Owner') || char(39) || 's agent' ELSE a.author_name END AS author_name".into() } else { format!("a.{column}") }).collect::<Vec<_>>().join(", ")))?.query_map([query],ann_row)?.collect::<Result<_,_>>()?;
        anns.into_iter().map(|annotation| {
            let document = self.0.query_row(&format!("SELECT {DOCUMENT_COLUMNS}, (SELECT count(*) FROM annotations WHERE document_id=d.id) AS annotation_count FROM documents d WHERE d.id=?1"),[&annotation.document_id],doc_row)?;
            Ok(SearchResult {annotation,document})
        }).collect()
    }
}
#[cfg(test)]
mod tests;
