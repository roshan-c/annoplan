// In-memory backend for recording the README demo; never touches a database.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import type { AnnotationBackend } from "../../src/backend";
import type { Annotation, Color, Document } from "../../src/types";
import "../../src/style.css";

const text = `# Reading with a pencil

A document you only read once is a document you mostly forget. The habit that changes this is small: keep a pencil in your hand, and leave a trace wherever the text makes you pause.

## Why margins matter

Margins are where a reader talks back. A single underline says *this mattered*; a note beside it says *why*. The best notes are arguments, not summaries, and they are written in your own words rather than the author's.

Over time those traces become an index of your attention. Returning to a book you have marked is faster than reading it fresh, because the passages that changed your mind are already waiting for you.

## Highlighting without losing the original

Digital highlights often live inside a single file or a single app. That makes them fragile: rename the file, switch readers, and the marks are gone. Keeping highlights beside the document, anchored to the words themselves, means the original stays untouched while your notes survive.

## Reading together

Some documents are better read with someone else. A shared link lets a colleague add their own highlights in real time, and an agent can read along too, pointing out passages that deserve a second look and leaving notes under its own name.

The goal is not to mark everything. It is to make the next reading shorter than the first.
`;

const doc: Document = {
  id: "demo",
  path: "/Users/ada/Notes/reading-with-a-pencil.md",
  content_hash: "demo",
  format: "md",
  title: "reading-with-a-pencil.md",
  added_at: new Date().toISOString(),
  last_opened_at: new Date().toISOString(),
  annotation_count: 0,
};
const data = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
let annotations: Annotation[] = [];
const listeners = new Set<() => void>();
const now = () => new Date().toISOString();

const backend: AnnotationBackend = {
  documents: async () => [{ ...doc, annotation_count: annotations.length }],
  open: async () => ({ document: doc, data }),
  annotations: async () => annotations.map((a) => ({ ...a })),
  save: async (a) => {
    const saved = {
      ...a,
      created_at: a.created_at || now(),
      updated_at: now(),
    };
    annotations = [...annotations.filter((x) => x.id !== a.id), saved];
    return saved;
  },
  delete: async (id) => {
    annotations = annotations.filter((a) => a.id !== id);
  },
  search: async (query) =>
    annotations
      .filter((a) => `${a.quote} ${a.note}`.toLowerCase().includes(query))
      .map((annotation) => ({ document: doc, annotation })),
  choose: async () => null,
  ownerName: async () => "Ada",
  reanchor: async (id, start, end) => {
    annotations = annotations.map((a) =>
      a.id === id ? { ...a, start_offset: start, end_offset: end } : a,
    );
  },
  subscribe: (_id, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

// Simulates an MCP client writing a highlight while the document is open.
(window as any).agentHighlight = (
  quote: string,
  note: string,
  color: Color,
) => {
  annotations = [
    ...annotations,
    {
      id: crypto.randomUUID(),
      document_id: doc.id,
      color,
      quote,
      prefix: "",
      suffix: "",
      start_offset: 0,
      end_offset: quote.length,
      page: null,
      rects_json: null,
      note,
      created_at: now(),
      updated_at: now(),
      source: "mcp",
      agent_client: "claude-code",
      author_name: "Ada's agent",
    },
  ];
  listeners.forEach((l) => l());
};

createRoot(document.getElementById("root")!).render(
  <App backend={backend} initial={{ document: doc, data }} />,
);
