import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function fixture(version = 3) {
  const dir = mkdtempSync(join(tmpdir(), "annoplan-mcp-"));
  const path = join(dir, "test.db");
  const db = new DatabaseSync(path);
  for (const migration of [
    "migration.sql",
    "migration_v2.sql",
    "migration_v3.sql",
    "migration_v4.sql",
  ].slice(0, version)) {
    db.exec(
      readFileSync(
        new URL("../../src-tauri/src/db/" + migration, import.meta.url),
        "utf8",
      ),
    );
  }
  db.exec(`PRAGMA user_version=${version}; PRAGMA journal_mode=WAL;`);
  const source = join(dir, "paper.pdf");
  writeFileSync(
    source,
    "Source existence only; server never reads document content",
  );
  const insertDoc = db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?)");
  insertDoc.run(
    "pdf",
    source,
    "hash-pdf",
    "pdf",
    "Research Paper",
    "2026-01-01",
    "2026-03-03",
  );
  insertDoc.run(
    "md",
    "/notes/Ideas.md",
    "hash-md",
    "md",
    "Ideas",
    "2026-01-01",
    "2026-02-02",
  );
  insertDoc.run(
    "docx",
    "/notes/Draft.docx",
    "hash-docx",
    "docx",
    "Draft",
    "2026-01-01",
    "2026-01-01",
  );
  insertAnnotation(
    db,
    "p2",
    "pdf",
    "green",
    'Attention, "please"!\nNext line.',
    "Remember attention",
    2,
    20,
  );
  insertAnnotation(db, "p1", "pdf", "yellow", "Attention matters", null, 1, 10);
  insertAnnotation(db, "p3", "pdf", "pink", "Later passage", "  ", 2, 40);
  insertAnnotation(
    db,
    "m1",
    "md",
    "blue",
    "Attention and care",
    "Useful idea",
    null,
    0,
  );
  insertAnnotation(db, "w1", "docx", "purple", "A Word passage", "", null, 0);
  return {
    dir,
    path,
    source,
    db,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function insertAnnotation(
  db: DatabaseSync,
  id: string,
  document: string,
  color: string,
  quote: string,
  note: string | null,
  page: number | null,
  offset: number,
) {
  db.prepare(
    `INSERT INTO annotations(id,document_id,color,quote,prefix,suffix,start_offset,end_offset,page,rects_json,note,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    document,
    color,
    quote,
    "before ",
    " after",
    offset,
    offset + quote.length,
    page,
    page ? '[{"x":0.1,"y":0.2,"width":0.3,"height":0.1}]' : null,
    note,
    "2026-01-01T00:00:00Z",
    "2026-02-01T00:00:00Z",
  );
}
export const serverPath = fileURLToPath(
  new URL("../dist/index.js", import.meta.url),
);
