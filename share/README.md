# Live shares

A Worker serves the viewer's static build and `/api/*`. Each share has a SQLite-backed `ShareRoom` Durable Object with annotations, participant token hashes, encrypted names, metadata, a monotonic event cursor, and hibernatable server-push WebSockets. HTTP carries all writes. R2 (`FILES`) holds one encrypted file. A separate SQLite-backed `RateLimiter` DO per hashed IP supplies simple minute-window counters.

The expiry alarm deletes the R2 object first, closes sockets, then deletes **all** room storage and its alarm. Cleanup retries if R2 fails. Every request also checks expiry. Revoke immediately removes the file, participants and annotations, leaving only an inaccessible expiry marker until the original alarm deletes it. Unknown malformed IDs return 404; unavailable well-formed IDs return 410, so expired links keep working after all storage is deleted.

## Local development (no Cloudflare account)

From the repository root:

```sh
pnpm install
pnpm --dir share install --frozen-lockfile
pnpm share:build
pnpm --dir share dev
# In another terminal:
VITE_SHARE_BASE_URL=http://127.0.0.1:8787 pnpm tauri dev
```

Wrangler uses local R2 and Durable Objects under `share/.wrangler/`. Never add `--remote`. Viewer assets are built into ignored `share/public/`; `/s/:id` serves `index.html`. The same renderers, selectors, annotation layer and popover serve both desktop and browser. Rebuild assets after frontend changes.

```sh
pnpm --dir share typecheck
pnpm --dir share test
```

Tests use a local Workers runtime and unique random rooms, with isolated storage disabled to avoid the macOS SQLite sidecar issue in the Vitest pool. The pinned Wrangler/runtime pair supports the configured compatibility date. No test needs account credentials.

## API

All JSON responses use `Cache-Control: no-store`. Credentials are `Authorization: Bearer <token>`; WebSockets use subprotocols `annoplan, auth.<token>` to avoid tokens in URLs. The server selects `annoplan`. Browser API calls are same-origin; CORS also permits the desktop and local frontend. IDs are a random UUID plus expiry epoch milliseconds. Annotation IDs are client-generated UUIDs.

- `POST /api/shares {expires_in_seconds, encrypted_meta}` → 201 `{shareId, ownerToken, expires_at}`. Lifetime must be an integer 3600–86400 seconds. Save credentials before uploading.
- `PUT /api/shares/:id/file` — owner only, encrypted binary, Content-Length required. Streamed to R2, once per share. AES envelope overhead of 29 bytes is allowed in addition to 50 MiB plaintext.
- `GET /api/shares/:id` → `{encrypted_meta, expires_at, participants}`. Names are ciphertext, presence is a boolean.
- `GET /api/shares/:id/file` → encrypted binary (404 before upload).
- `POST /api/shares/:id/join {encrypted_name}` → 201 `{participantId, participantToken}`. Client encrypts and remembers display name/token in localStorage for this share.
- `GET /api/shares/:id/annotations?since=0` → `{annotations, cursor}`. `since` is an exclusive monotonic integer event cursor, not wall-clock time. Returns latest state/tombstone for each changed annotation.
- `PUT /api/shares/:id/annotations/:uuid {ciphertext, updated_at}` → canonical wire annotation. Token required. Only original author can edit; owner has no override.
- `DELETE /api/shares/:id/annotations/:uuid {updated_at}` → tombstone. Same ownership rule.
- `DELETE /api/shares/:id` — owner only; revoke.
- `GET /api/shares/:id/ws` — authenticated upgrade. Events: `ready`, `upsert`/`delete` with `annotation`, `participants` with participant list, `expired`. Connect **before** catch-up to avoid gaps; reconnect with backoff then catch up. No client writes over the socket.

Wire annotations: `{id, participant_id, ciphertext|null, updated_at, deleted, seq}`. `updated_at` is canonical ISO UTC; older/equal writes are successful no-ops. Timestamps more than a minute in the future are rejected. Tombstones retain ownership and prevent old retries resurrecting annotations. Cursors order delivery independently of client clocks.

## Security model and limits

AES-256-GCM runs in WebCrypto. The random 256-bit key appears only in `#k=<base64url>`; fragments are not sent in HTTP requests. File bytes, title/format/owner name, participant display names, and annotation JSON are encrypted with a fresh 96-bit IV. Authenticated context strings bind ciphertext to its role/annotation UUID. The server stores SHA-256 token hashes, never plaintext tokens or share keys.

The server sees IP addresses at request time, hashed IP rate buckets, opaque IDs, participation/presence, ciphertext sizes, annotation ownership, timestamps and access patterns. It cannot read document contents, notes, quotes, colors or names. Link possession grants decryption and joining. Anyone with the link can copy/re-share/download content; expiry cannot erase recipients' copies. Names are self-asserted, not verified. A malicious participant can misstate a name or encrypted content; the server's participant ID remains the ownership authority. The server delivers the JavaScript: a compromised deployment can steal keys. Local SQLite and localStorage store credentials in plaintext; macOS account/browser security is required. Browser extensions and XSS can access them. No telemetry or third-party assets are used; referrers are disabled and CSP restricts resource loading.

Limits: 50 MiB file, 256 KiB encrypted annotation envelope (includes JSON escaping and encryption overhead for 32 KiB MCP notes), 2000 annotation IDs including tombstones, 50 recipients (owner additional), 100 WebSockets. Per hashed IP/minute: 10 creates, 20 joins, 180 writes; share-specific caps cannot be bypassed by multiple IPs. Rate limiting is intentionally basic: no global spend cap or download throttling. Consider account billing alerts before exposing a public deployment.

Owner edits and recipient imports are persisted locally. Sync only runs while the document is open. The owner must reconnect before expiry to receive changes made while offline; after server deletion they cannot be recovered. Recipient annotations already imported stay in SQLite after expiry/revoke.

## Deployment — run these yourself

`wrangler.jsonc` intentionally omits `account_id` and routes; choose the account during login or set `CLOUDFLARE_ACCOUNT_ID` in your shell. Without a route the Worker deploys to its `*.workers.dev` URL. To use your own domain, add `"routes": [{"pattern":"share.example.com", "custom_domain":true}]` (the zone must be in that account) or attach it through Workers → Settings → Domains & Routes.

```sh
pnpm --dir share install --frozen-lockfile
pnpm share:build
cd share
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create annoplan-files
pnpm exec wrangler deploy
```

The deploy creates/migrates SQLite-backed DO namespaces and binds R2 and static assets. No DNS or account changes are performed by tests or local dev. Then build the desktop app against it:

```sh
echo 'VITE_SHARE_BASE_URL=https://share.example.com' > .env.local
pnpm tauri build
```

The Worker accepts its own origin plus the Tauri and local-dev origins; the desktop CSP gains the configured host at build time.

## Local end-to-end harness

With the local Worker running and assets built, run `pnpm exec playwright install chromium` and `pnpm share:e2e` from the root. The harness uses `DesktopSync` with a JSON-lines adapter to the production Rust `Database` methods and a temporary SQLite database. It opens md/pdf/docx fixtures as two separate Chromium contexts and exercises the real selection/popover flow. It does not launch/automate the native Tauri window. Screenshots and results are printed under a temporary directory.

Owner-authenticated `PUT /api/shares/:id` replaces only encrypted metadata and broadcasts a `metadata` event. Recipients refresh it on catch-up too, so owner/agent display labels follow name changes without plaintext names or per-annotation frozen agent labels. Agent annotations use the existing owner identity on the wire; participants cannot edit or delete them.
