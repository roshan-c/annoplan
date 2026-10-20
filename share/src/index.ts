import { DurableObject } from "cloudflare:workers";
export interface Env {
  FILES: R2Bucket;
  ROOMS: DurableObjectNamespace<ShareRoom>;
  RATE_LIMITS: DurableObjectNamespace<RateLimiter>;
  ASSETS: Fetcher;
}
const MAX_FILE = 50 * 1024 * 1024 + 29; // AES envelope overhead
const MAX_PAYLOAD = 32 * 1024;
// JSON escaping and AES/base64 overhead for MCP notes of up to 32 KB.
const MAX_ANNOTATION = 256 * 1024;
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers });
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
function opaque(value: unknown, max = MAX_PAYLOAD): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length < 39 ||
    Math.ceil((value.length * 3) / 4) > max
  )
    fail(400, "Invalid or oversized ciphertext");
  return value;
}
async function body(request: Request, max = 46000) {
  if (Number(request.headers.get("Content-Length")) > max)
    fail(413, "Payload too large");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      fail(413, "Payload too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all)) as Record<string, unknown>;
  } catch {
    return fail(400, "Invalid JSON");
  }
}
async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function expiryFromId(id: string) {
  return Number(id.split(".")[1]);
}
function validId(id: string) {
  return /^[a-f0-9-]{36}\.\d{13}$/.test(id);
}
interface Meta {
  encrypted_meta: string;
  expires_at: number;
  owner_hash: string;
  file_key: string;
  gone?: boolean;
}
interface Participant {
  id: string;
  token_hash: string;
  encrypted_name: string;
}
export interface WireAnnotation {
  id: string;
  participant_id: string;
  ciphertext: string | null;
  updated_at: string;
  deleted: boolean;
  seq: number;
}
export class RateLimiter extends DurableObject<Env> {
  async fetch(request: Request) {
    const { kind } = await request.json<{ kind: string }>();
    const key = `${kind}:${Math.floor(Date.now() / 60000)}`;
    const count = (await this.ctx.storage.get<number>(key)) ?? 0;
    const limit = kind === "join" ? 20 : kind === "create" ? 10 : 180;
    if (count >= limit)
      return json({ error: "Too many requests; retry in a minute" }, 429);
    await this.ctx.storage.put(key, count + 1);
    await this.ctx.storage.setAlarm(Date.now() + 120000);
    return json({ ok: true });
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
export class ShareRoom extends DurableObject<Env> {
  private pending: Promise<unknown> = Promise.resolve();
  private broadcast(event: unknown) {
    const text = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text);
      } catch {
        socket.close(1011, "Connection lost");
      }
    }
  }
  private participants() {
    const online = new Set(
      this.ctx
        .getWebSockets()
        .map((ws) => ws.deserializeAttachment()?.id as string),
    );
    return this.ctx.storage.list<Participant>({ prefix: "p:" }).then((rows) => [
      { id: "owner", encrypted_name: null, online: online.has("owner") },
      ...Array.from(rows.values()).map((p) => ({
        id: p.id,
        encrypted_name: p.encrypted_name,
        online: online.has(p.id),
      })),
    ]);
  }
  private async cleanup(meta: Meta, revoked = false) {
    // Delete file first: if R2 fails, the alarm retries and requests remain expired.
    await this.env.FILES.delete(meta.file_key);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "expired" }));
        socket.close(4001, "Share expired");
      } catch {
        /* already closed */
      }
    }
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    if (revoked && Date.now() < meta.expires_at) {
      await this.ctx.storage.put("meta", {
        ...meta,
        encrypted_meta: "",
        owner_hash: "",
        gone: true,
      });
      await this.ctx.storage.setAlarm(meta.expires_at);
    }
  }
  async alarm() {
    const result = this.pending.then(async () => {
      const meta = await this.ctx.storage.get<Meta>("meta");
      if (meta) await this.cleanup(meta);
    });
    this.pending = result.catch(() => {});
    await result;
  }
  async fetch(request: Request): Promise<Response> {
    // Serialise auth + mutations across awaits, so concurrent joins/writes respect caps.
    const result = this.pending.then(async () => {
      try {
        return await this.route(request);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error("Share request failed");
        return json({ error: "Share service unavailable" }, 500);
      }
    });
    this.pending = result.catch(() => {});
    return result;
  }
  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url),
      parts = url.pathname.split("/").filter(Boolean),
      id = parts[2],
      action = parts[3];
    let meta = await this.ctx.storage.get<Meta>("meta");
    if (request.method === "POST" && action === "init") {
      if (meta) fail(409, "Already created");
      const input = await body(request),
        seconds = Number(input.expires_in_seconds);
      if (!Number.isInteger(seconds) || seconds < 3600 || seconds > 86400)
        fail(400, "Lifetime must be 1–24 hours");
      const expires_at = expiryFromId(id);
      if (
        expires_at < Date.now() + 3590000 ||
        expires_at > Date.now() + 86400000
      )
        fail(400, "Invalid expiry");
      const ownerToken = token();
      meta = {
        encrypted_meta: opaque(input.encrypted_meta),
        expires_at,
        owner_hash: await hash(ownerToken),
        file_key: id,
      };
      await this.ctx.storage.put("meta", meta);
      await this.ctx.storage.setAlarm(expires_at);
      return json(
        {
          shareId: id,
          ownerToken,
          expires_at: new Date(expires_at).toISOString(),
        },
        201,
      );
    }
    if (!meta) fail(410, "This link has expired or is unavailable");
    if (Date.now() >= meta.expires_at) {
      await this.cleanup(meta);
      fail(410, "This link has expired");
    }
    if (meta.gone) fail(410, "This link has expired or was revoked");
    const auth = async () => {
      const raw =
        request.headers.get("Authorization")?.replace(/^Bearer /, "") ??
        request.headers
          .get("Sec-WebSocket-Protocol")
          ?.split(",")
          .map((p) => p.trim())
          .find((p) => p.startsWith("auth."))
          ?.slice(5);
      if (!raw || raw.length > 128) fail(401, "Token required");
      const digest = await hash(raw);
      if (digest === meta!.owner_hash) return "owner";
      const participants = await this.ctx.storage.list<Participant>({
        prefix: "p:",
      });
      for (const p of participants.values())
        if (p.token_hash === digest) return p.id;
      return fail(403, "Invalid token");
    };
    if (!action && request.method === "GET")
      return json({
        encrypted_meta: meta.encrypted_meta,
        expires_at: new Date(meta.expires_at).toISOString(),
        participants: await this.participants(),
      });
    if (!action && request.method === "PUT") {
      if ((await auth()) !== "owner") fail(403, "Owner only");
      meta.encrypted_meta = opaque((await body(request)).encrypted_meta);
      await this.ctx.storage.put("meta", meta);
      this.broadcast({ type: "metadata", encrypted_meta: meta.encrypted_meta });
      return json({ ok: true });
    }
    if (!action && request.method === "DELETE") {
      if ((await auth()) !== "owner") fail(403, "Owner only");
      await this.cleanup(meta, true);
      return json({ ok: true });
    }
    if (action === "file") {
      if (request.method === "PUT") {
        if ((await auth()) !== "owner") fail(403, "Owner only");
        if (await this.env.FILES.head(meta.file_key))
          fail(409, "File already uploaded");
        const length = Number(request.headers.get("Content-Length"));
        if (!Number.isSafeInteger(length) || length < 29)
          fail(411, "Content-Length required");
        if (length > MAX_FILE) fail(413, "File exceeds 50 MB");
        if (!request.body) fail(400, "Missing file");
        const fixed = new FixedLengthStream(length);
        const transfer = request.body.pipeTo(fixed.writable);
        await Promise.all([
          this.env.FILES.put(meta.file_key, fixed.readable, {
            httpMetadata: { contentType: "application/octet-stream" },
          }),
          transfer,
        ]);
        if (Date.now() >= meta.expires_at) {
          await this.cleanup(meta);
          fail(410, "This link has expired");
        }
        return json({ ok: true });
      }
      if (request.method === "GET") {
        const object = await this.env.FILES.get(meta.file_key);
        if (!object) fail(404, "File not uploaded yet");
        return new Response(object.body, {
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(object.size),
          },
        });
      }
    }
    if (action === "join" && request.method === "POST") {
      const input = await body(request),
        encrypted_name = opaque(input.encrypted_name, 1024);
      const participants = await this.ctx.storage.list({ prefix: "p:" });
      if (participants.size >= 50)
        fail(409, "This share has reached 50 participants");
      const participantToken = token(),
        participantId = crypto.randomUUID();
      await this.ctx.storage.put(`p:${participantId}`, {
        id: participantId,
        token_hash: await hash(participantToken),
        encrypted_name,
      } satisfies Participant);
      this.broadcast({
        type: "participants",
        participants: await this.participants(),
      });
      return json({ participantId, participantToken }, 201);
    }
    if (action === "annotations") {
      const annId = parts[4];
      if (request.method === "GET" && !annId) {
        const since = Number(url.searchParams.get("since") ?? 0);
        if (!Number.isSafeInteger(since) || since < 0)
          fail(400, "Invalid event cursor");
        const all = await this.ctx.storage.list<WireAnnotation>({
          prefix: "a:",
        });
        return json({
          annotations: Array.from(all.values())
            .filter((a) => a.seq > since)
            .sort((a, b) => a.seq - b.seq),
          cursor: (await this.ctx.storage.get<number>("seq")) ?? 0,
        });
      }
      if (annId && (request.method === "PUT" || request.method === "DELETE")) {
        if (!/^[a-f0-9-]{36}$/.test(annId))
          fail(400, "Annotation UUID required");
        const participant_id = await auth(),
          input = await body(request, 360000),
          updated_at = input.updated_at;
        if (
          typeof updated_at !== "string" ||
          !Number.isFinite(Date.parse(updated_at)) ||
          Date.parse(updated_at) > Date.now() + 60000
        )
          fail(400, "Invalid timestamp");
        const canonical = new Date(updated_at).toISOString();
        const existing = await this.ctx.storage.get<WireAnnotation>(
          `a:${annId}`,
        );
        if (existing && existing.participant_id !== participant_id)
          fail(403, "You can only change your own annotations");
        const ciphertext =
          request.method === "DELETE"
            ? null
            : opaque(input.ciphertext, MAX_ANNOTATION);
        if (existing && canonical <= existing.updated_at) return json(existing);
        if (
          !existing &&
          (await this.ctx.storage.list({ prefix: "a:" })).size >= 2000
        )
          fail(409, "Annotation limit reached");
        const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
        const annotation: WireAnnotation = {
          id: annId,
          participant_id,
          ciphertext,
          updated_at: canonical,
          deleted: request.method === "DELETE",
          seq,
        };
        await this.ctx.storage.put({ [`a:${annId}`]: annotation, seq });
        this.broadcast({
          type: annotation.deleted ? "delete" : "upsert",
          annotation,
        });
        return json(annotation);
      }
    }
    if (action === "ws" && request.method === "GET") {
      const participant = await auth();
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        fail(426, "WebSocket upgrade required");
      if (this.ctx.getWebSockets().length >= 100)
        fail(429, "Connection limit reached");
      const pair = new WebSocketPair(),
        client = pair[0],
        server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id: participant });
      server.send(JSON.stringify({ type: "ready" }));
      this.broadcast({
        type: "participants",
        participants: await this.participants(),
      });
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { "Sec-WebSocket-Protocol": "annoplan" },
      });
    }
    fail(404, "Unknown endpoint");
  }
  async webSocketMessage(ws: WebSocket) {
    const meta = await this.ctx.storage.get<Meta>("meta");
    if (!meta || meta.gone || Date.now() >= meta.expires_at) {
      if (meta) await this.alarm();
      else ws.close(4001, "Share expired");
      return;
    }
    // WebSockets are server-push only. HTTP writes have a single authentication path.
    ws.close(1008, "Use HTTP for writes");
  }
  async webSocketClose(ws: WebSocket) {
    ws.close();
    this.broadcast({
      type: "participants",
      participants: await this.participants(),
    });
  }
  async webSocketError(ws: WebSocket) {
    ws.close(1011, "Connection lost");
  }
}
const allowedOrigins = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://127.0.0.1:1420",
  "http://localhost:1420",
  "http://127.0.0.1:8787",
]);
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url),
      origin = request.headers.get("Origin");
    if (!url.pathname.startsWith("/api/")) {
      const target = new URL(request.url);
      if (/^\/s\/[^/]+\/?$/.test(target.pathname)) target.pathname = "/";
      const response = await env.ASSETS.fetch(new Request(target, request));
      const secure = new Response(response.body, response);
      secure.headers.set("Referrer-Policy", "no-referrer");
      secure.headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      return secure;
    }
    if (origin && !allowedOrigins.has(origin) && origin !== url.origin)
      return json({ error: "Origin not allowed" }, 403);
    const cors = (response: Response) => {
      if (response.status === 101) return response;
      const result = new Response(response.body, response);
      if (origin) {
        result.headers.set("Access-Control-Allow-Origin", origin);
        result.headers.set("Vary", "Origin");
      }
      result.headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      result.headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      return result;
    };
    if (request.method === "OPTIONS")
      return cors(new Response(null, { status: 204 }));
    try {
      const kind =
        request.method === "POST" && url.pathname === "/api/shares"
          ? "create"
          : url.pathname.endsWith("/join") && request.method === "POST"
            ? "join"
            : ["PUT", "DELETE"].includes(request.method)
              ? "write"
              : null;
      if (kind) {
        const ip = request.headers.get("CF-Connecting-IP") ?? "local";
        const limiter = env.RATE_LIMITS.get(
          env.RATE_LIMITS.idFromName(await hash(ip)),
        );
        const result = await limiter.fetch("https://rate/", {
          method: "POST",
          body: JSON.stringify({ kind }),
        });
        if (!result.ok) return cors(result);
      }
      if (url.pathname === "/api/shares" && request.method === "POST") {
        const input = await body(request),
          seconds = Number(input.expires_in_seconds);
        if (!Number.isInteger(seconds) || seconds < 3600 || seconds > 86400)
          fail(400, "Lifetime must be 1–24 hours");
        const id = `${crypto.randomUUID()}.${Date.now() + seconds * 1000}`;
        const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
        return cors(
          await stub.fetch(`https://room/api/shares/${id}/init`, {
            method: "POST",
            body: JSON.stringify(input),
          }),
        );
      }
      const match = url.pathname.match(/^\/api\/shares\/([^/]+)(?:\/.*)?$/),
        id = match?.[1];
      if (!id || !validId(id)) fail(404, "Share not found");
      if (url.pathname.endsWith("/init")) fail(404, "Unknown endpoint");
      return cors(await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(request));
    } catch (e) {
      return cors(
        json(
          {
            error:
              e instanceof HttpError ? e.message : "Share service unavailable",
          },
          e instanceof HttpError ? e.status : 500,
        ),
      );
    }
  },
} satisfies ExportedHandler<Env>;
