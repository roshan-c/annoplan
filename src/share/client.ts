import type { Annotation, Document, Opened } from "../types";
import type { AnnotationBackend } from "../backend";
import { colors } from "../types";
import {
  base64url,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  generateKey,
} from "./crypto";
// Empty unless the build sets VITE_SHARE_BASE_URL; sharing is hidden without it.
export const SHARE_BASE = (import.meta.env?.VITE_SHARE_BASE_URL || "").replace(
  /\/$/,
  "",
);
export interface ShareMetadata {
  title: string;
  format: Document["format"];
  owner_name: string;
}
export interface WireAnnotation {
  id: string;
  participant_id: string;
  ciphertext: string | null;
  updated_at: string;
  deleted: boolean;
  seq: number;
}
interface WireParticipant {
  id: string;
  encrypted_name: string | null;
  online: boolean;
}
export interface Person {
  id: string;
  name: string;
  online: boolean;
}
export class ShareError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  base: string,
  path: string,
  method = "GET",
  input?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`${base}/api/shares${path}`, {
    method,
    headers: {
      ...(input !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ShareError(
      response.status,
      error.error || `Share request failed (${response.status})`,
    );
  }
  return response.json();
}
export async function createShare(
  base: string,
  metadata: ShareMetadata,
  bytes: Uint8Array,
  seconds: number,
) {
  if (bytes.length > 50 * 1024 * 1024)
    throw new Error("Files must be 50 MB or smaller");
  const key = await generateKey();
  const created = await request<{
    shareId: string;
    ownerToken: string;
    expires_at: string;
  }>(base, "", "POST", {
    expires_in_seconds: seconds,
    encrypted_meta: await encryptJson(key, metadata, "meta"),
  });
  try {
    const encrypted = await encryptBytes(key, bytes, "file");
    const response = await fetch(`${base}/api/shares/${created.shareId}/file`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${created.ownerToken}` },
      body: encrypted,
    });
    if (!response.ok)
      throw new Error(`File upload failed (${response.status})`);
  } catch (error) {
    await request(
      base,
      `/${created.shareId}`,
      "DELETE",
      undefined,
      created.ownerToken,
    ).catch(() => {});
    throw error;
  }
  return { ...created, key, url: `${base}/s/${created.shareId}#k=${key}` };
}
/** Validates untrusted decrypted JSON before it reaches anchoring or SQLite. */
export function validateAnnotation(value: unknown): Annotation {
  if (!value || typeof value !== "object")
    throw new Error("Invalid annotation");
  const a = value as Annotation;
  if (
    typeof a.quote !== "string" ||
    !a.quote.length ||
    typeof a.prefix !== "string" ||
    typeof a.suffix !== "string" ||
    !colors.includes(a.color) ||
    !Number.isSafeInteger(a.start_offset) ||
    a.start_offset < 0 ||
    !Number.isSafeInteger(a.end_offset) ||
    a.end_offset <= a.start_offset ||
    !(a.page === null || (Number.isSafeInteger(a.page) && a.page! > 0)) ||
    !(a.note === null || typeof a.note === "string") ||
    !(a.rects_json === null || typeof a.rects_json === "string")
  )
    throw new Error("Invalid annotation fields");
  if (a.source !== undefined && !["app", "mcp", "share"].includes(a.source))
    throw new Error("Invalid annotation source");
  if (
    a.agent_client !== undefined &&
    a.agent_client !== null &&
    typeof a.agent_client !== "string"
  )
    throw new Error("Invalid agent client");
  return a;
}
export class ShareClient implements AnnotationBackend {
  readonly items = new Map<string, Annotation>();
  people: Person[] = [];
  private versions = new Map<string, number>();
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private queue = Promise.resolve();
  private backoff = 500;
  private cursor = 0;
  onChange?: (
    wire: WireAnnotation,
    annotation: Annotation | null,
  ) => Promise<void>;
  onCursor?: (cursor: string) => Promise<void>;
  onExpired?: () => void;
  onError?: (error: unknown) => void;
  constructor(
    readonly base: string,
    readonly id: string,
    readonly key: string,
    readonly actorId: string,
    readonly token: string,
    readonly name: string,
    readonly metadata: ShareMetadata,
    readonly expiresAt: string,
    readonly opened: Opened,
    readonly resumeCursor = 0,
  ) {
    this.cursor = resumeCursor;
  }
  documents = async () => [];
  open = async () => this.opened;
  annotations = async () =>
    Array.from(this.items.values()).sort(
      (a, b) => a.start_offset - b.start_offset,
    );
  search = async () => [];
  choose = async () => null;
  canEdit = (a: Annotation) => a.author_id === this.actorId;
  subscribe = (_id: string, listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private async apply(wire: WireAnnotation) {
    if ((this.versions.get(wire.id) ?? 0) >= wire.seq) return;
    let annotation: Annotation | null = null;
    if (!wire.deleted && wire.ciphertext) {
      let raw: Annotation;
      try {
        raw = validateAnnotation(
          await decryptJson<unknown>(
            this.key,
            wire.ciphertext,
            `annotation:${wire.id}`,
          ),
        );
      } catch (error) {
        this.onError?.(
          new Error(
            `Skipped unreadable annotation ${wire.id}: ${String(error)}`,
          ),
        );
        this.versions.set(wire.id, wire.seq);
        return;
      }
      annotation = {
        ...raw,
        source:
          wire.participant_id === "owner" ? (raw.source ?? "app") : "share",
        agent_client:
          wire.participant_id === "owner" ? (raw.agent_client ?? null) : null,
        id: wire.id,
        document_id: this.opened.document.id,
        author_id: wire.participant_id,
        author_name:
          wire.participant_id === "owner"
            ? raw.source === "mcp"
              ? `${this.metadata.owner_name}'s agent`
              : this.metadata.owner_name
            : this.people.find((p) => p.id === wire.participant_id)?.name ||
              "Contributor",
        share_id: this.id,
        updated_at: wire.updated_at,
      };
    }
    await this.onChange?.(wire, annotation);
    if (annotation) this.items.set(wire.id, annotation);
    else this.items.delete(wire.id);
    this.versions.set(wire.id, wire.seq);
    this.emit();
  }
  private async metadataFrom(encrypted: string) {
    const meta = await decryptJson<ShareMetadata>(this.key, encrypted, "meta");
    if (typeof meta.owner_name !== "string")
      throw new Error("Invalid owner name");
    this.metadata.owner_name = meta.owner_name;
    for (const a of this.items.values())
      if (a.author_id === "owner")
        a.author_name =
          a.source === "mcp" ? `${meta.owner_name}'s agent` : meta.owner_name;
    for (const p of this.people) if (p.id === "owner") p.name = meta.owner_name;
    this.emit();
  }
  async setOwnerName(name: string) {
    if (this.actorId !== "owner") throw new Error("Owner only");
    const encrypted_meta = await encryptJson(
      this.key,
      { ...this.metadata, owner_name: name },
      "meta",
    );
    await request(
      this.base,
      `/${this.id}`,
      "PUT",
      { encrypted_meta },
      this.token,
    );
    await this.metadataFrom(encrypted_meta);
  }
  private async peopleFrom(wire: WireParticipant[]) {
    this.people = await Promise.all(
      wire.map(async (p) => ({
        id: p.id,
        name:
          p.id === "owner"
            ? this.metadata.owner_name
            : await decryptJson<unknown>(
                this.key,
                p.encrypted_name || "",
                "name",
              )
                .then((value) =>
                  typeof value === "string"
                    ? value.slice(0, 80)
                    : "Contributor",
                )
                .catch(() => "Contributor"),
        online: p.online,
      })),
    );
    this.emit();
  }
  /** Full catch-up advances cursor only after every import is durable. */
  async catchUp() {
    const meta = await request<{
      participants: WireParticipant[];
      encrypted_meta: string;
    }>(this.base, `/${this.id}`);
    await this.metadataFrom(meta.encrypted_meta);
    await this.peopleFrom(meta.participants);
    const changes = await request<{
      annotations: WireAnnotation[];
      cursor: number;
    }>(this.base, `/${this.id}/annotations?since=${this.cursor}`);
    for (const wire of changes.annotations) await this.apply(wire);
    this.cursor = changes.cursor;
    await this.onCursor?.(String(this.cursor));
  }
  private enqueue(task: () => Promise<void>) {
    const result = this.queue.then(task);
    this.queue = result.catch((error) => {
      if (error instanceof ShareError && error.status === 410) this.expire();
      else {
        this.onError?.(error);
        this.socket?.close();
      }
    });
    return result;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const remaining = Date.parse(this.expiresAt) - Date.now();
    if (remaining <= 0) {
      this.expire();
      return;
    }
    this.expiryTimer = setTimeout(() => this.expire(), remaining);
    const connect = () => {
      if (this.stopped) return;
      const url = new URL(`${this.base}/api/shares/${this.id}/ws`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, ["annoplan", `auth.${this.token}`]);
      this.socket = socket;
      socket.onopen = () => {
        this.backoff = 500;
        void this.enqueue(() => this.catchUp()).catch(() => {});
      };
      socket.onmessage = (event) => {
        void this.enqueue(async () => {
          const message = JSON.parse(String(event.data));
          if (message.type === "expired") {
            this.expire();
            return;
          }
          if (message.type === "metadata")
            await this.metadataFrom(message.encrypted_meta);
          if (message.type === "participants")
            await this.peopleFrom(message.participants);
          if (message.type === "upsert" || message.type === "delete")
            await this.apply(message.annotation);
        }).catch(() => {});
      };
      socket.onclose = (event) => {
        if (this.stopped) return;
        if (event.code === 4001) {
          this.expire();
          return;
        }
        this.onError?.(new Error("Reconnecting to share…"));
        this.timer = setTimeout(connect, this.backoff);
        this.backoff = Math.min(15000, this.backoff * 2);
      };
      socket.onerror = () => socket.close();
    };
    connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.expiryTimer);
    this.socket?.close();
    this.socket = null;
  }
  private expire() {
    this.stop();
    this.onExpired?.();
  }
  async save(a: Annotation): Promise<Annotation> {
    const existing = this.items.get(a.id);
    if (existing && !this.canEdit(existing))
      throw new Error("You can only edit your own annotations");
    const timestamp = new Date().toISOString(),
      annotation = {
        ...a,
        author_id: this.actorId,
        author_name: this.name,
        created_at: a.created_at || timestamp,
        updated_at: timestamp,
      };
    await this.put(annotation);
    return this.items.get(a.id)!;
  }
  async put(annotation: Annotation) {
    const ciphertext = await encryptJson(
      this.key,
      annotation.source === "mcp"
        ? { ...annotation, author_name: null }
        : annotation,
      `annotation:${annotation.id}`,
    );
    const wire = await request<WireAnnotation>(
      this.base,
      `/${this.id}/annotations/${annotation.id}`,
      "PUT",
      { ciphertext, updated_at: annotation.updated_at },
      this.token,
    );
    await this.enqueue(() => this.apply(wire));
  }
  async delete(id: string) {
    await this.remove(id, new Date().toISOString());
  }
  async remove(id: string, updated_at: string) {
    const wire = await request<WireAnnotation>(
      this.base,
      `/${this.id}/annotations/${id}`,
      "DELETE",
      { updated_at },
      this.token,
    );
    await this.enqueue(() => this.apply(wire));
  }
}
export async function loadShare(base: string, id: string, key: string) {
  const wire = await request<{
    encrypted_meta: string;
    expires_at: string;
    participants: WireParticipant[];
  }>(base, `/${id}`);
  const metadata = await decryptJson<ShareMetadata>(
    key,
    wire.encrypted_meta,
    "meta",
  );
  if (
    !["md", "pdf", "docx"].includes(metadata.format) ||
    typeof metadata.title !== "string" ||
    typeof metadata.owner_name !== "string"
  )
    throw new Error("Invalid shared document");
  const response = await fetch(`${base}/api/shares/${id}/file`);
  if (!response.ok)
    throw new ShareError(response.status, "Shared document is unavailable");
  const data = await decryptBytes(
    key,
    new Uint8Array(await response.arrayBuffer()),
    "file",
  );
  const document: Document = {
    id,
    path: id,
    title: metadata.title,
    format: metadata.format,
    content_hash: "",
    added_at: "",
    last_opened_at: "",
    annotation_count: 0,
  };
  // Opened is the existing desktop renderer contract (base64, not base64url).
  const opened: Opened = {
    document,
    data: base64url(data).replaceAll("-", "+").replaceAll("_", "/"),
  };
  return { metadata, opened, expiresAt: wire.expires_at };
}
