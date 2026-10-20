<img src="assets/icon.svg" width="64" height="64" alt="annoplan icon">

# annoplan

A macOS document reader for keeping useful passages. Open PDF, Markdown, and Word (.docx) documents, highlight in five colours, and attach optional notes. Original documents are never modified. Annotations stay in a local SQLite database.

## Run and build

Requires macOS 12+, Node 24, pnpm 10, Rust, and Xcode command-line tools. Prebuilt binaries are not published; build from source.

```sh
pnpm install
pnpm tauri dev
```

```sh
pnpm typecheck
pnpm vitest run
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --debug
```

The debug application bundle is `src-tauri/target/debug/bundle/macos/annoplan.app`.
For a release bundle use `pnpm tauri build`. Signing/notarization is not configured.
`pnpm dev` runs the frontend shell in a browser; opening files and persistence require the desktop application.

The checked-in app icons are generated from `assets/icon.svg`. Regenerate with `node scripts/icon.mjs && pnpm tauri icon /tmp/annoplan-icon.png`. PDF font, CMap, and WASM assets are copied from the installed npm package by `postinstall`; document data stays local unless you create a share.

## Reading and annotating

- Open with **File → Open** / **⌘O**, drag a supported file onto the window, or use **Open Recent**. Documents open in tabs; **⌘W** closes the active tab.
- Select text for a colour/note popover. Turn on **Highlight** (**⇧⌘H**) to apply the current colour immediately. Click a highlight to change its colour, add/edit its note, or delete it.
- The sidebar switches between PDF thumbnails / document headings and **Highlights & Notes**. Click a passage to scroll to it. Notes have a yellow margin indicator; the toolbar controls their visibility.
- Markdown has **Rendered / Plain** views; plain source is read only. Both views use the same quote anchoring system. Formatting can make a rendered quote unavailable verbatim in source; it stays listed as unattached until a matching view is restored.
- **Library** (**⇧⌘L**) lists all opened documents and annotation counts. Its search matches words across every quote and note; click a result to open its document at the passage. The toolbar search filters the current document's annotations.
- **⌘F** focuses search, **⌘+ / ⌘− / ⌘0** control zoom, and **⌃⌘S** toggles the sidebar. Tabs remember zoom, Markdown mode, and scroll position during the session.

Sample files live in `fixtures/`. Regenerate locally with `pnpm fixtures` (no downloads).

## Live share links

Click **Share** on an open document, enter **Your name** (defaults to your macOS full name), and choose 1, 4, 12, or 24 hours. Copy the link to any number of people, up to 50 recipients. There is no sign-in: each recipient chooses a remembered display name. They use the same PDF, Markdown, and DOCX renderers and annotation tools in a stripped browser reader. The header shows expiry and presence; Highlights can be filtered by author. Each person can edit/delete their own annotations. Revoke ends access immediately.

Shares use end-to-end AES-256-GCM encryption. The key is in the link fragment, never sent to the server. While the document is open, owner and recipient annotations sync live in both directions; recipient annotations are saved with attribution in local SQLite and **remain after expiry/revoke**. Closing the document pauses sync. Reopen before expiry to catch up; changes never downloaded before expiry are lost when the server deletes the share. A durable local outbox retries owner edits and deletes after disconnection. Only one live link per document is offered at a time.

The optional [`share/`](share/README.md) Cloudflare Worker serves the web viewer/API, uses R2 for encrypted files and one SQLite-backed Durable Object per share, with hibernatable WebSockets and expiry alarms. No Cloudflare deployment is performed by development or tests. Sharing needs your own deployment: set `VITE_SHARE_BASE_URL` to its origin (for example in a gitignored `.env.local`). Without it the **Share** button is hidden. `pnpm tauri dev` / `pnpm tauri build` add that host to the app's CSP automatically. Local setup:

```sh
pnpm --dir share install --frozen-lockfile
pnpm share:build
pnpm --dir share dev
# Separate terminal:
VITE_SHARE_BASE_URL=http://127.0.0.1:8787 pnpm tauri dev
```

Verification:

```sh
pnpm --dir share typecheck
pnpm --dir share test
pnpm exec playwright install chromium
# With local wrangler dev running and current viewer assets built:
pnpm share:e2e
```

The end-to-end harness uses the actual desktop sync engine and Rust database methods over JSON lines, with two isolated Chromium recipients for each fixture format. It checks live adds/edits/deletes, owner edits, permissions, reopen catch-up, remembered identity, revoke, expired pages, and retained SQLite attribution. Test databases/screenshots are temporary. It never opens the default user DB. See `share/README.md` for the API, limits, security caveats and deployment commands to run yourself.

## Architecture

Tauri v2 hosts a React / TypeScript / Vite frontend and a Rust backend. Markdown uses markdown-it (raw HTML disabled), PDF uses pdf.js canvas pages with selectable text layers, and Word uses docx-preview. Nearby PDF pages and thumbnails mount lazily; text is extracted for anchoring before display. PDF annotation selections are scoped to a single page. Image-only PDFs need an existing text layer; OCR is not included.

`src/annotation/anchoring.ts` implements W3C TextQuote + TextPosition selectors. Position is checked against the exact quote first; otherwise quote matches are scored by shared prefix/suffix context. An equally plausible duplicate, or no match, is orphaned and stays visible in the sidebar. DOM overlays do not wrap or rewrite renderer-owned text. Coordinates are recomputed after layout/zoom changes.

External links and remote document resources are blocked in the reading view. Markdown local image references are not resolved. DOCX fidelity depends on docx-preview and the fonts installed on the Mac; complex Word layouts may differ. Documents are loaded into memory; PDF canvases are virtualized, but extracted text and original bytes remain in memory. Password-protected PDFs are not supported in this version. The Library and tabs are application views, not separate native windows.

## SQLite contract for MCP readers

Database: **`~/Library/Application Support/annoplan/annoplan.db`**. Rust uses rusqlite with bundled SQLite, foreign keys enabled, WAL journaling, and a five-second busy timeout. A separate reader can open this path read-only. Leave `annoplan.db-wal` and `annoplan.db-shm` alongside it while the app runs; use SQLite's backup API for consistent copies.

Files are identified by SHA-256 of their complete bytes, computed in Rust. Opening identical content at another path updates that document's path and title while keeping its ID and annotations. Changed file contents become a new document; the app never alters the source file. UUID strings identify documents and annotations. Timestamps are UTC RFC 3339 strings. SQL `PRAGMA user_version` and `schema_version` record the current version (4) and the applied migration history, respectively. Each migration is transactional; table rebuilds disable foreign keys before the transaction, check them before commit, and re-enable them afterwards.

The ordered migrations are [`migration.sql`](src-tauri/src/db/migration.sql) [`migration_v2.sql`](src-tauri/src/db/migration_v2.sql), [`migration_v3.sql`](src-tauri/src/db/migration_v3.sql), and [`migration_v4.sql`](src-tauri/src/db/migration_v4.sql). The core annotation schema is shown below; v3 also adds shares/outbox, and v4 adds settings, agent write attribution and outbox triggers (see [schema v4 details](mcp/README.md#schema-and-encrypted-shares)):

```sql
CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE documents(
 id TEXT PRIMARY KEY, path TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE,
 format TEXT NOT NULL CHECK(format IN ('md','pdf','docx')), title TEXT NOT NULL,
 added_at TEXT NOT NULL, last_opened_at TEXT NOT NULL
);
CREATE TABLE annotations(
 seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink','purple')),
 quote TEXT NOT NULL CHECK(length(quote)>0), prefix TEXT NOT NULL DEFAULT '', suffix TEXT NOT NULL DEFAULT '',
 start_offset INTEGER NOT NULL CHECK(start_offset>=0), end_offset INTEGER NOT NULL CHECK(end_offset>start_offset),
 page INTEGER CHECK(page IS NULL OR page>0), rects_json TEXT, note TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 author_id TEXT NULL, author_name TEXT NULL, share_id TEXT NULL,
 source TEXT NOT NULL DEFAULT 'app' CHECK(source IN ('app','mcp','share')), agent_client TEXT
);
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
```

`format` normalizes `.markdown` to `md`. Offsets count **UTF-16 code units**, matching DOM Range / JavaScript, not UTF-8 bytes or Unicode code points. Markdown and DOCX text is the concatenation of renderer text nodes in DOM order, excluding style/script/annotation UI nodes; HTML block boundaries add no synthetic characters. Plain Markdown uses its exact source string. PDF text concatenates pdf.js `TextItem.str` in page order without synthetic page separators. `page` is 1-based for PDFs and NULL otherwise. PDF offsets are document-wide; `rects_json` is an array of `{x,y,width,height}` fractions relative to the page's top-left origin (0–1). Prefix and suffix retain up to 32 UTF-16 code units each. Orphan status is derived for the current renderer view, not persisted.

FTS is an external-content table joined through the stable integer primary key `annotations.seq`, maintained by the three triggers. External readers (including the MCP server) should identify annotations by the public UUID `id` and use `seq` only for FTS joins. `seq` aliases SQLite’s rowid and survives `VACUUM`. Example reader query:

```sql
SELECT a.id, a.quote, a.note, d.path, d.title
FROM annotations_fts
JOIN annotations a ON a.seq = annotations_fts.rowid
JOIN documents d ON d.id = a.document_id
WHERE annotations_fts MATCH '"attention"'
ORDER BY rank;
```

Tauri commands: `open_document(path)` → `{document,data}` (base64 file bytes), `list_documents()` (with computed `annotation_count`), `list_annotations(documentId)`, `save_annotation(annotation)`, `delete_annotation(id)`, and `search_annotations(query)`. Saves preserve selector fields and original creation time on edits; colour/note changes update `updated_at`. Global search quotes each whitespace-separated term and combines them with AND, returning at most 200 passages. Document editing is not included. The MCP server below exports saved annotations as Markdown.

## MCP server

The self-contained [`mcp/`](mcp/) package exposes saved highlights and notes to AI agents through the official TypeScript MCP SDK and stdio. It requires **Node 24** and uses built-in `node:sqlite` with no native database dependency. It reads schema versions 2, 3 and 4, opens SQLite read-only by default with a five-second busy timeout, and takes a fresh snapshot for every call. Set `ANNOPLAN_MCP_WRITE=1` to enable agent-owned highlight writes (requires schema v4). See [MCP tools, write configuration and text parity](mcp/README.md). The app can keep writing in WAL mode. Source documents are never modified.

Build from the repository root:

```sh
pnpm --dir mcp install --frozen-lockfile
pnpm mcp:build
pnpm mcp:test
```

The executable is `mcp/dist/index.js` (also the package's `annoplan-mcp` bin). Rebuild after changing the server source. The default database is `~/Library/Application Support/annoplan/annoplan.db`; set `ANNOPLAN_DB` to an absolute path to read another database. Missing databases and unsupported schema versions produce tool errors without stopping the server; later calls re-check the database. Leave the WAL/SHM sidecars in place while the app is running.

Available tools (all return readable text and structured content with declared output schemas):

- `list_documents({ query?, format?, limit? })`: newest-opened documents with highlight and nonblank-note counts. Title/path queries are literal case-insensitive substrings; format is `md`, `pdf`, or `docx`. Default limit 50.
- `get_document_annotations({ document_id?, path?, color?, author?, with_notes_only?, include_anchors? })`: highlights in page/offset order with notes and timestamps. Anchors are omitted unless requested.
- `search_annotations({ query, document_id?, color?, author?, limit? })`: literal whitespace-separated FTS terms combined with AND, ranked by BM25, with short snippets. Searches highlights and notes, not full document text. Default limit 20.
- `get_annotation({ id })`: one highlight, its document, and prefix/suffix and position context.
- `export_document_annotations({ document_id?, path?, format: "markdown" })`: a Markdown digest with quotes, notes, and PDF page markers. Use this for “summarise my notes on X”.

Document lookup requires an ID or exact source path; existing symlinks are resolved. If both are supplied they must identify the same document. Colors are `yellow`, `green`, `blue`, `pink`, and `purple`. Tool limits accept 1–1000. Annotation identifiers are public UUIDs, never internal SQLite row IDs. Resources are `annoplan://documents` (the complete JSON document list) and `annoplan://documents/{id}/annotations` (the Markdown digest).

To verify your database through the stdio client without registering anything:

```sh
pnpm --dir mcp check:db
# Or: ANNOPLAN_DB=/absolute/path/to/test.db pnpm --dir mcp check:db
```

**Claude Code** — paste this command after building:

```sh
claude mcp add annoplan -- node /absolute/path/to/annoplan/mcp/dist/index.js
```

**Claude Desktop / JSON-based MCP clients** — merge this into the client's `mcpServers` config (Claude Desktop on macOS uses `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "annoplan": {
      "command": "node",
      "args": ["/absolute/path/to/annoplan/mcp/dist/index.js"]
    }
  }
}
```

To override the database in JSON, add `"env": { "ANNOPLAN_DB": "/absolute/path/to/annoplan.db" }` inside the `annoplan` object. Ensure the client can find Node 24; GUI clients may need the absolute path returned by `command -v node`.

**Codex** uses TOML rather than `mcpServers` JSON. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.annoplan]
command = "node"
args = ["/absolute/path/to/annoplan/mcp/dist/index.js"]

# Optional:
# [mcp_servers.annoplan.env]
# ANNOPLAN_DB = "/absolute/path/to/annoplan.db"
```

Alternatively register it with the Codex CLI:

```sh
codex mcp add annoplan -- node /absolute/path/to/annoplan/mcp/dist/index.js
```

See the [official Codex MCP configuration documentation](https://developers.openai.com/codex/mcp). These examples are instructions only; building and testing this package does not register it in any client.

### Schema v3 sharing tables

`author_id`, `author_name`, and `share_id` on annotations are nullable; NULL author means the local owner. Recipient attribution and annotations survive expiry/revoke. `shares` stores local share credentials and progress:

```sql
CREATE TABLE shares(
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 share_key TEXT NOT NULL, owner_token TEXT NOT NULL, url TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, last_event_at TEXT
);
CREATE TABLE share_outbox(
 share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
 annotation_id TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(share_id, annotation_id)
);
```

MCP annotation outputs include `author_name` (null = owner). The optional `author` filter matches an exact display name, or JSON null for the owner. Read-only mode also supports v2 databases (all authors null). Agent highlights expose `source='mcp'`, `agent_client`, and a dynamic “{owner name}'s agent” author label; see [MCP write tools](mcp/README.md).

## Licence

[MIT](LICENSE)
