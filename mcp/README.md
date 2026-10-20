# annoplan MCP

Requires Node 24. Build with `pnpm --dir mcp install --frozen-lockfile` and
`pnpm --dir mcp build`. Open the desktop app once to migrate the database.
The default database is `~/Library/Application Support/annoplan/annoplan.db`;
`ANNOPLAN_DB` overrides it. Never copy a running database without its WAL.

```json
{
  "mcpServers": {
    "annoplan": {
      "command": "node",
      "args": ["/absolute/path/to/annoplan/mcp/dist/index.js"],
      "env": { "ANNOPLAN_MCP_WRITE": "1" }
    }
  }
}
```

Omit `ANNOPLAN_MCP_WRITE` for read-only access. Only the exact value `1` enables
writes. Read-only mode still uses SQLite's read-only flag and supports schemas
2, 3 and 4. Write mode requires schema 4, opens read-write, enables foreign keys,
uses a five-second busy timeout, and commits each mutation in one immediate
transaction. Missing/unsupported databases return errors telling you to open the
app; the MCP server never creates or migrates databases.

## Tools

Existing tools: `list_documents`, `get_document_annotations`, `search_annotations`,
`get_annotation`, `export_document_annotations`. Read outputs include `source`,
`agent_client`, and `author_name` (the display label); owner labels remain null.
Author filters match the current display name, or null for owner highlights.

`get_document_text(document_id, page?, offset?, limit?)` is always available.
PDF defaults to page 1; `page` is one-based and PDF-only. `offset` defaults to 0,
`limit` to 10,000 (maximum 20,000). Output includes `page_count`, `base_offset`,
`total_chars`, and `next_offset` for continuing within a page. Add `base_offset`
to a page-local offset to get the annotation's document offset.

When writes are enabled:

- `create_annotation(document_id, quote, prefix?, suffix?, note?, color?, page?)`:
  quote must be an exact match. Repeated quotes require enough prefix/suffix
  context to select a unique best match, or a PDF page. Context scoring is shared
  with the viewer, including whitespace normalization and rejection of ties.
  Saved anchors include 32 UTF-16 code units of prefix/suffix. Quotes cannot cross
  PDF pages. Default color is yellow; allowed colors are yellow/green/blue/pink/purple.
- `update_annotation(id, note?, color?)`: edits only agent-authored highlights;
  send `note: null` to clear a note.
- `delete_annotation(id)`: deletes only agent-authored highlights.

Quote maximum: 2,000 UTF-16 code units. Note maximum: 32 KiB of UTF-8. Write tools
reject unknown arguments, including model/harness fields. Harness attribution
comes only from `clientInfo.name` and `clientInfo.version` in the MCP initialize
handshake; no model is accepted or recorded. `agent_writes` keeps operation,
annotation ID, harness and time, including after deletion (no quote/note copy).

There is one shared agent identity across clients and sessions. Any MCP client
with writes enabled can edit any `source='mcp'` highlight, but cannot change an
owner or participant highlight. In **annoplan → Settings…**, set “Your name”
(initialized from the macOS account full name). Agent labels are computed as
“{your name}'s agent”; renaming updates local views and active shares. The desktop
owner can edit/delete agent highlights. MCP changes appear in the open document
within about a second via `PRAGMA data_version` polling.

## Text and offset parity

All offsets use JavaScript UTF-16 code units, matching DOM Range and the app.
No artificial spaces or newlines are inserted between text items.

- Markdown uses the default **rendered** mode, with the same markdown-it options
  (`html: false`, `linkify: true`, `typographer: true`). JSDOM parses its HTML;
  text nodes (including generated whitespace) are concatenated exactly like the
  app. The app's optional plain mode uses Markdown source, so offsets can differ;
  exact quotes reanchor across modes when the same quote survives rendering.
- PDF uses the same PDF.js version and `getTextContent()` items as the viewer,
  concatenating `str` values per page and accumulating page base offsets. Node
  uses the legacy PDF.js build and local CMaps/fonts. Unusual fonts, marked
  content, normalization or browser text-layer behavior can differ. No OCR is
  performed on scanned pages.
- DOCX uses the same docx-preview version, rendering options and text-node filtering in a
  script/resource-disabled JSDOM. This closely matches the app's text DOM;
  layout-dependent tabs, page breaks, headers/footers and fonts may differ because
  JSDOM has no browser layout engine. Node uses Blob URLs instead of base64 URLs
  for embedded assets; asset encoding contributes no text nodes. DOCX is one continuous text surface, just
  like the app; `page` is not supported.

Use the extracted quote/context instead of guessing positions. If the viewer
finds a quote at a corrected position, it persists the corrected offsets for
owner-side annotations (including agent highlights). If a quote itself differs
between renderers, automatic reanchoring cannot repair it; pick a shorter exact
passage in `get_document_text`.

## Schema and encrypted shares

Migration v4 adds constrained `source` (`app`/`mcp`/`share`) and nullable
`agent_client`, backfilling v3 participant rows to `share` and all others to `app`.
Existing selector/text/timestamps, IDs, FTS, shares and pending outbox rows survive.
`settings` holds the owner name. Agent rows retain `author_id=NULL` and
`share_id=NULL`, so they belong to the owner and sync using owner authorization.
Recipients cannot modify them, enforced by the existing worker ownership check.

SQLite insert/update/delete triggers enqueue active, unexpired, unrevoked shares
for every writer. Deletes leave tombstones; entries disappear only after a matching
revision acknowledgement. Remote import/delete sets `sync_remote_apply` inside
the same transaction, suppressing echo even for owner-side rows. SQLite serializes
writers; transaction rollback also clears the marker on errors or process failure.
Existing conflict and pending-local-write protection remains in place.

Agent source and harness travel inside the encrypted annotation. The current owner
name travels separately in encrypted share metadata; owner-authenticated metadata
updates notify connected recipients and catch-up refreshes it after reconnect.
Agent display names are not frozen into annotation payloads. The worker never sees
annotation text, names or harnesses; keys remain solely in the URL fragment.
The encrypted annotation limit is 256 KiB, allowing JSON escaping and encryption
overhead for an allowed 32 KiB note.

Run `pnpm --dir mcp test` (includes the TypeScript build). Tests use temporary
databases initialized from the real ordered Rust migration SQL.
