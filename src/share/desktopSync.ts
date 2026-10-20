import type { AnnotationBackend } from "../backend";
import type { Annotation, Opened, Share } from "../types";
import { decode } from "../backend";
import {
  createShare,
  request,
  ShareClient,
  ShareError,
  type ShareMetadata,
} from "./client";
import { decryptJson } from "./crypto";
export interface Pending {
  id: string;
  updated_at: string;
  deleted: boolean;
}
/** Native IPC and the local integration harness both implement this contract. */
export interface ShareStore {
  shares(documentId: string): Promise<Share[]>;
  saveShare(share: Share): Promise<void>;
  importAnnotation(annotation: Annotation): Promise<void>;
  remoteDelete(
    id: string,
    shareId: string,
    authorId: string | null,
  ): Promise<void>;
  outbox(shareId: string): Promise<Pending[]>;
  acknowledge(shareId: string, id: string, updatedAt: string): Promise<void>;
}
export class DesktopSync {
  readonly backend: AnnotationBackend;
  private opened = new Map<string, Opened>();
  private listeners = new Map<string, Set<() => void>>();
  private clients = new Map<string, ShareClient>();
  private loops = new Map<string, ReturnType<typeof setInterval>>();
  private generations = new Map<string, number>();
  private flushing = new Set<string>();
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  onStatus?: (status: string) => void;
  constructor(
    private local: AnnotationBackend,
    private store: ShareStore,
  ) {
    this.backend = {
      ...local,
      open: async (path) => {
        const file = await local.open(path);
        this.opened.set(file.document.id, file);
        return file;
      },
      save: async (a) => {
        const saved = await local.save(a);
        void this.flushDocument(a.document_id);
        return saved;
      },
      delete: async (id) => {
        await local.delete(id);
        for (const doc of this.listeners.keys()) void this.flushDocument(doc);
      },
      canEdit: (a) => !a.author_id,
      subscribe: (id, listener) => {
        let listeners = this.listeners.get(id);
        if (!listeners) {
          listeners = new Set();
          this.listeners.set(id, listeners);
        }
        listeners.add(listener);
        const unsubscribe = local.subscribe?.(id, listener);
        if (listeners.size === 1)
          void this.connect(id).catch((e) => this.status(e));
        return () => {
          unsubscribe?.();
          listeners!.delete(listener);
          if (!listeners!.size) {
            this.listeners.delete(id);
            this.disconnect(id);
          }
        };
      },
    };
  }
  dispose() {
    for (const documentId of this.listeners.keys()) this.disconnect(documentId);
    this.listeners.clear();
  }
  private status(error: unknown) {
    this.onStatus?.(String(error));
  }
  private notify(id: string) {
    for (const fn of this.listeners.get(id) ?? []) fn();
  }
  private disconnect(documentId: string) {
    clearTimeout(this.retries.get(documentId));
    this.retries.delete(documentId);
    this.generations.set(
      documentId,
      (this.generations.get(documentId) ?? 0) + 1,
    );
    for (const [id, client] of this.clients)
      if (client.opened.document.id === documentId) {
        client.stop();
        this.clients.delete(id);
        clearInterval(this.loops.get(id));
        this.loops.delete(id);
      }
  }
  async connect(documentId: string) {
    this.disconnect(documentId);
    const generation = this.generations.get(documentId),
      file = this.opened.get(documentId);
    if (!file) return;
    const shares = await this.store.shares(documentId);
    for (const share of shares) {
      if (share.revoked_at || Date.parse(share.expires_at) <= Date.now())
        continue;
      try {
        const base = new URL(share.url).origin;
        const wire = await request<{ encrypted_meta: string }>(
          base,
          `/${share.id}`,
        );
        const meta = await decryptJson<ShareMetadata>(
          share.share_key,
          wire.encrypted_meta,
          "meta",
        );
        if (
          generation !== this.generations.get(documentId) ||
          !this.listeners.has(documentId)
        )
          return;
        const client = new ShareClient(
          base,
          share.id,
          share.share_key,
          "owner",
          share.owner_token,
          meta.owner_name,
          meta,
          share.expires_at,
          file,
          Number(share.last_event_at || 0),
        );
        client.onChange = (event, annotation) =>
          this.mirror(share, event.id, annotation, event.participant_id);
        client.onCursor = async (cursor) => {
          share.last_event_at = cursor;
          await this.store.saveShare(share);
        };
        client.onError = (e) => this.status(e);
        client.onExpired = () => {
          clearInterval(this.loops.get(share.id));
          this.loops.delete(share.id);
          this.clients.delete(share.id);
          this.onStatus?.(
            "Share ended. Imported annotations are saved on this Mac.",
          );
          this.notify(documentId);
        };
        this.clients.set(share.id, client);
        client.start();
        const flush = () =>
          void this.flush(share, client).catch((e) => this.status(e));
        this.loops.set(share.id, setInterval(flush, 800));
        flush();
      } catch (e) {
        if (e instanceof ShareError && e.status === 410) {
          share.revoked_at = new Date().toISOString();
          await this.store.saveShare(share);
        } else {
          this.status(e);
          if (
            this.listeners.has(documentId) &&
            generation === this.generations.get(documentId)
          )
            this.retries.set(
              documentId,
              setTimeout(
                () =>
                  void this.connect(documentId).catch((e) => this.status(e)),
                2000,
              ),
            );
        }
      }
    }
  }
  private async mirror(
    share: Share,
    id: string,
    annotation: Annotation | null,
    participantId: string,
  ) {
    const authorId = participantId === "owner" ? null : participantId;
    if (annotation)
      await this.store.importAnnotation({
        ...annotation,
        document_id: share.document_id,
        author_id: authorId,
        author_name: authorId ? annotation.author_name : null,
        share_id: authorId ? share.id : null,
      });
    else await this.store.remoteDelete(id, share.id, authorId);
    this.notify(share.document_id);
  }
  private async flush(share: Share, client: ShareClient) {
    if (this.flushing.has(share.id)) return;
    this.flushing.add(share.id);
    try {
      const name = await this.local.ownerName?.();
      if (name && name !== client.metadata.owner_name)
        await client.setOwnerName(name);
      const pending = await this.store.outbox(share.id);
      for (const p of pending) {
        if (
          this.clients.get(share.id) !== client ||
          !this.listeners.has(share.document_id)
        )
          return;
        if (p.deleted) await client.remove(p.id, p.updated_at);
        else {
          const a = (await this.local.annotations(share.document_id)).find(
            (a) => a.id === p.id,
          );
          if (!a) continue;
          await client.put({ ...a, updated_at: p.updated_at });
        }
        await this.store.acknowledge(share.id, p.id, p.updated_at);
        // A rejected stale write can return a newer server revision. Apply it after
        // acknowledging, while a newer queued local revision stays protected in SQL.
        const authoritative = client.items.get(p.id) ?? null;
        await this.mirror(
          share,
          p.id,
          authoritative,
          authoritative?.author_id || "owner",
        );
      }
    } catch (e) {
      if (e instanceof ShareError && e.status === 410) {
        client.stop();
        clearInterval(this.loops.get(share.id));
        this.clients.delete(share.id);
        this.loops.delete(share.id);
        this.onStatus?.(
          "Share ended. Imported annotations are saved on this Mac.",
        );
      } else throw e;
    } finally {
      this.flushing.delete(share.id);
    }
  }
  async flushDocument(documentId: string) {
    for (const share of await this.store.shares(documentId)) {
      const client = this.clients.get(share.id);
      if (client) await this.flush(share, client).catch((e) => this.status(e));
    }
  }
  people(documentId: string) {
    return Array.from(this.clients.values())
      .filter((c) => c.opened.document.id === documentId)
      .flatMap((c) => c.people);
  }
  async create(file: Opened, base: string, name: string, seconds: number) {
    const existing = (await this.store.shares(file.document.id)).find(
      (s) => !s.revoked_at && Date.parse(s.expires_at) > Date.now(),
    );
    if (existing)
      throw new Error("Revoke the current link before creating another.");
    const created = await createShare(
      base,
      {
        title: file.document.title,
        format: file.document.format,
        owner_name: name,
      },
      decode(file.data),
      seconds,
    );
    const share: Share = {
      id: created.shareId,
      document_id: file.document.id,
      share_key: created.key,
      owner_token: created.ownerToken,
      url: created.url,
      expires_at: created.expires_at,
      created_at: new Date().toISOString(),
      revoked_at: null,
      last_event_at: null,
    };
    try {
      await this.store.saveShare(share);
    } catch (error) {
      await request(
        base,
        `/${share.id}`,
        "DELETE",
        undefined,
        share.owner_token,
      ).catch(() => {});
      throw error;
    }
    this.opened.set(file.document.id, file);
    await this.connect(file.document.id);
    await this.flushDocument(file.document.id);
    return share;
  }
  async revoke(share: Share) {
    try {
      await request(
        new URL(share.url).origin,
        `/${share.id}`,
        "DELETE",
        undefined,
        share.owner_token,
      );
    } catch (e) {
      if (!(e instanceof ShareError && e.status === 410)) throw e;
    }
    share.revoked_at = new Date().toISOString();
    await this.store.saveShare(share);
    this.disconnect(share.document_id);
    this.notify(share.document_id);
  }
}
