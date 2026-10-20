import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Annotation, Document, Opened, SearchResult } from "./types";
export const native = isTauri();
import type { AnnotationBackend, DesktopEvents } from "./backend";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
export const api: AnnotationBackend = {
  ownerName: () => invoke<string>("default_owner_name"),
  setOwnerName: (name) => invoke<void>("set_owner_name", { name }),
  reanchor: (id, start, end) =>
    invoke<void>("reanchor_annotation", { id, start, end }),
  subscribe: (_documentId, listener) => {
    let version: number | undefined,
      stopped = false,
      busy = false;
    const poll = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const next = await invoke<number>("data_version");
        if (!stopped && version !== next) listener();
        version = next;
      } catch (error) {
        console.error("Database refresh failed", error);
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  },
  documents: () =>
    native ? invoke<Document[]>("list_documents") : Promise.resolve([]),
  open: (path: string) => invoke<Opened>("open_document", { path }),
  annotations: (documentId: string) =>
    invoke<Annotation[]>("list_annotations", { documentId }),
  save: (annotation: Annotation) =>
    invoke<Annotation>("save_annotation", { annotation }),
  delete: (id: string) => invoke<void>("delete_annotation", { id }),
  search: (query: string) =>
    invoke<SearchResult[]>("search_annotations", { query }),
  choose: () =>
    open({
      multiple: false,
      filters: [
        { name: "Documents", extensions: ["pdf", "md", "markdown", "docx"] },
      ],
    }),
};
export const desktopEvents: DesktopEvents = {
  attach(action, openPath) {
    if (!native) return () => {};
    const menu = listen<string>("menu-action", (e) =>
      e.payload.startsWith("open-path:")
        ? openPath(e.payload.slice(10))
        : action(e.payload),
    );
    const drop = getCurrentWebviewWindow().onDragDropEvent((e) => {
      if (e.payload.type === "drop" && e.payload.paths[0])
        openPath(e.payload.paths[0]);
    });
    return () => {
      void menu.then((f) => f());
      void drop.then((f) => f());
    };
  },
};

export const shareStore: import("./share/desktopSync").ShareStore = {
  shares: (documentId) => invoke("list_shares", { documentId }),
  saveShare: (share) => invoke("save_share", { share }),
  importAnnotation: (annotation) => invoke("import_annotation", { annotation }),
  remoteDelete: (id, shareId, authorId) =>
    invoke("remote_delete", { id, shareId, authorId }),
  outbox: (shareId) => invoke("share_outbox", { shareId }),
  acknowledge: (shareId, id, updatedAt) =>
    invoke("acknowledge_share", { shareId, id, updatedAt }),
};
export const defaultOwnerName = () =>
  native ? invoke<string>("default_owner_name") : Promise.resolve("");
