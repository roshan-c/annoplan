import type { Annotation, Document, Opened, SearchResult } from "./types";
/** Persistence contract shared by desktop and browser. No native dependencies. */
export interface AnnotationBackend {
  documents(): Promise<Document[]>;
  open(path: string): Promise<Opened>;
  annotations(documentId: string): Promise<Annotation[]>;
  save(annotation: Annotation): Promise<Annotation>;
  delete(id: string): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
  choose(): Promise<string | string[] | null>;
  ownerName?(): Promise<string>;
  setOwnerName?(name: string): Promise<void>;
  reanchor?(id: string, start: number, end: number): Promise<void>;
  subscribe?(documentId: string, listener: () => void): () => void;
  canEdit?(annotation: Annotation): boolean;
}
export interface DesktopEvents {
  attach(
    action: (id: string) => void,
    open: (path: string) => void,
  ): () => void;
}
export function decode(data: string) {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
