import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { Handlers, invoke, sanitizeFtsQuery } from "../src/handlers.js";
import { fixture, insertAnnotation } from "./fixture.js";

describe("read-only handlers against real migrations", () => {
  let data: ReturnType<typeof fixture>;
  let handlers: Handlers;
  beforeEach(() => {
    data = fixture();
    handlers = new Handlers(data.path);
  });
  afterEach(() => data.close());

  it("lists counts, recent order, literal substring filters, format and limits", () => {
    expect(
      handlers
        .listDocuments()
        .documents.map((d) => [d.id, d.annotation_count, d.notes_count]),
    ).toEqual([
      ["pdf", 3, 1],
      ["md", 1, 1],
      ["docx", 1, 0],
    ]);
    expect(
      handlers.listDocuments({ query: "IDEAS.MD" }).documents.map((d) => d.id),
    ).toEqual(["md"]);
    expect(handlers.listDocuments({ query: "%" }).documents).toEqual([]);
    expect(
      handlers.listDocuments({ format: "docx" }).documents.map((d) => d.id),
    ).toEqual(["docx"]);
    expect(
      handlers.listDocuments({ limit: 1 }).documents.map((d) => d.id),
    ).toEqual(["pdf"]);
    data.db.prepare("UPDATE documents SET title=? WHERE id='md'").run("ÉTUDES");
    expect(
      handlers.listDocuments({ query: "études" }).documents.map((d) => d.id),
    ).toEqual(["md"]);
  });

  it("reads in page/offset order, filters notes/color, and only includes anchors on request", () => {
    const result = handlers.getDocumentAnnotations({ document_id: "pdf" });
    expect(result.document.title).toBe("Research Paper");
    expect(result.annotations.map((a) => a.id)).toEqual(["p1", "p2", "p3"]);
    expect(result.annotations[0]).not.toHaveProperty("prefix");
    expect(result.annotations[0]).not.toHaveProperty("rects_json");
    expect(result.annotations[0]).not.toHaveProperty("seq");
    expect(
      handlers
        .getDocumentAnnotations({ document_id: "pdf", with_notes_only: true })
        .annotations.map((a) => a.id),
    ).toEqual(["p2"]);
    const anchored = handlers.getDocumentAnnotations({
      document_id: "pdf",
      color: "green",
      include_anchors: true,
    });
    expect(anchored.annotations).toHaveLength(1);
    expect(anchored.annotations[0]).toMatchObject({
      id: "p2",
      prefix: "before ",
      suffix: " after",
      start_offset: 20,
    });
  });

  it("returns attribution and filters by exact author or owner", () => {
    data.db
      .prepare(
        "UPDATE annotations SET author_id='sam',author_name='Sam' WHERE id='p2'",
      )
      .run();
    expect(handlers.getAnnotation({ id: "p2" }).annotation.author_name).toBe(
      "Sam",
    );
    expect(
      handlers.exportDocumentAnnotations({
        document_id: "pdf",
        format: "markdown",
      }).markdown,
    ).toContain("Author: Sam");
    expect(
      handlers
        .getDocumentAnnotations({ document_id: "pdf", author: "Sam" })
        .annotations.map((a) => a.id),
    ).toEqual(["p2"]);
    expect(
      handlers
        .getDocumentAnnotations({ document_id: "pdf", author: null })
        .annotations.map((a) => a.id),
    ).toEqual(["p1", "p3"]);
    expect(
      handlers
        .searchAnnotations({ query: "attention", author: "Sam" })
        .results.map((r) => r.annotation.id),
    ).toEqual(["p2"]);
    expect(
      handlers
        .searchAnnotations({ query: "attention", author: null })
        .results.map((r) => r.annotation.id)
        .sort(),
    ).toEqual(["m1", "p1"]);
  });

  it("resolves symlinks, accepts stored paths for missing files, and rejects mismatched selectors", () => {
    const link = join(data.dir, "linked.pdf");
    symlinkSync(data.source, link);
    expect(handlers.getDocumentAnnotations({ path: link }).document.id).toBe(
      "pdf",
    );
    expect(
      handlers.getDocumentAnnotations({ path: "/notes/Ideas.md" }).document.id,
    ).toBe("md");
    expect(() => handlers.getDocumentAnnotations({})).toThrow(
      "Provide document_id or path",
    );
    expect(() =>
      handlers.getDocumentAnnotations({ document_id: "md", path: data.source }),
    ).toThrow("Document not found");
  });

  it("uses literal AND FTS terms, ranks by bm25, searches notes, and returns public IDs with snippets", () => {
    const results = handlers.searchAnnotations({ query: "attention" }).results;
    const ranked = data.db
      .prepare(
        `SELECT a.id FROM annotations_fts JOIN annotations a ON a.seq=annotations_fts.rowid
      WHERE annotations_fts MATCH '"attention"' ORDER BY bm25(annotations_fts), a.id`,
      )
      .all()
      .map((row) => row.id);
    expect(results.map((r) => r.annotation.id)).toEqual(ranked);
    expect(results[0].document).toHaveProperty("path");
    expect(
      results.some(
        (r) =>
          r.snippet.includes("[Attention]") ||
          r.snippet.includes("[attention]"),
      ),
    ).toBe(true);
    expect(
      handlers
        .searchAnnotations({ query: "Useful" })
        .results.map((r) => r.annotation.id),
    ).toEqual(["m1"]);
    expect(
      handlers
        .searchAnnotations({ query: 'Attention, "please"!' })
        .results.map((r) => r.annotation.id),
    ).toEqual(["p2"]);
    expect(
      handlers.searchAnnotations({ query: "attention OR care" }).results,
    ).toEqual([]);
    expect(
      handlers
        .searchAnnotations({
          query: "attention",
          color: "green",
          document_id: "pdf",
          limit: 1,
        })
        .results.map((r) => r.annotation.id),
    ).toEqual(["p2"]);
    expect(handlers.searchAnnotations({ query: "   " }).results).toEqual([]);
    expect(handlers.searchAnnotations({ query: '"""' }).results).toEqual([]);
  });

  it("gets a single annotation with context and exports a readable Markdown digest", () => {
    expect(handlers.getAnnotation({ id: "p2" })).toMatchObject({
      annotation: {
        id: "p2",
        prefix: "before ",
        suffix: " after",
        note: "Remember attention",
      },
      document: { id: "pdf" },
    });
    const markdown = handlers.exportDocumentAnnotations({
      path: data.source,
      format: "markdown",
    }).markdown;
    expect(markdown).toContain("# Research Paper\n\nSource: " + data.source);
    expect(markdown).toContain("3 highlights · 1 note");
    expect(markdown).toContain(
      '> Attention, "please"!\n> Next line.\n\nRemember attention\n\np. 2',
    );
    expect(markdown.indexOf("p. 1")).toBeLessThan(markdown.indexOf("p. 2"));
    expect(
      handlers.exportDocumentAnnotations({
        document_id: "md",
        format: "markdown",
      }).markdown,
    ).not.toContain("p. ");
    expect(() => handlers.getAnnotation({ id: "absent" })).toThrow(
      "Annotation not found: absent",
    );
  });

  it("returns clear tool errors and recovers when a missing DB appears or the version changes", () => {
    const missing = new Handlers(join(data.dir, "later.db"));
    const error = invoke(missing, "list_documents", {});
    expect(error).toMatchObject({
      isError: true,
      structuredContent: {
        error: expect.stringContaining("open the app once"),
      },
    });
    expect(error.content[0].text).toContain(join(data.dir, "later.db"));
    symlinkSync(data.path, join(data.dir, "later.db"));
    expect(invoke(missing, "list_documents", {})).not.toHaveProperty("isError");
    data.db.exec("PRAGMA user_version=99");
    expect(invoke(handlers, "list_documents", {})).toMatchObject({
      isError: true,
      structuredContent: {
        error:
          "unsupported schema version 99; expected 2, 3 or 4; open the app to migrate",
      },
    });
    data.db.exec("PRAGMA user_version=3");
    expect(handlers.listDocuments().documents).toHaveLength(3);
  });

  it("sees later commits and reads a stable snapshot while a separate WAL writer holds a transaction", () => {
    expect(
      handlers.getDocumentAnnotations({ document_id: "md" }).annotations,
    ).toHaveLength(1);
    const writer = new DatabaseSync(data.path);
    try {
      writer.exec("BEGIN IMMEDIATE");
      insertAnnotation(
        writer,
        "new",
        "md",
        "yellow",
        "New attention",
        "fresh",
        null,
        80,
      );
      expect(
        handlers
          .getDocumentAnnotations({ document_id: "md" })
          .annotations.map((a) => a.id),
      ).toEqual(["m1"]);
      expect(handlers.searchAnnotations({ query: "fresh" }).results).toEqual(
        [],
      );
      writer.exec("COMMIT");
      expect(
        handlers
          .getDocumentAnnotations({ document_id: "md" })
          .annotations.map((a) => a.id),
      ).toEqual(["m1", "new"]);
      expect(
        handlers
          .searchAnnotations({ query: "fresh" })
          .results.map((r) => r.annotation.id),
      ).toEqual(["new"]);
    } finally {
      writer.close();
    }
  });
});

it("quotes each whitespace term and escapes embedded quotes instead of accepting FTS operators", () => {
  expect(sanitizeFtsQuery('  alpha\n"beta" OR title:gamma*  ')).toBe(
    '"alpha" AND """beta""" AND "OR" AND "title:gamma*"',
  );
  expect(sanitizeFtsQuery(" \t ")).toBe("");
});

it("reads an actual v2 database without author columns", () => {
  const data = fixture(2);
  try {
    const handlers = new Handlers(data.path);
    expect(
      data.db
        .prepare("PRAGMA table_info(annotations)")
        .all()
        .some((r) => r.name === "author_name"),
    ).toBe(false);
    expect(
      handlers.getAnnotation({ id: "p1" }).annotation.author_name,
    ).toBeNull();
    expect(
      handlers.getDocumentAnnotations({ document_id: "pdf", author: null })
        .annotations,
    ).toHaveLength(3);
    expect(
      handlers.searchAnnotations({ query: "attention", author: "Sam" }).results,
    ).toEqual([]);
  } finally {
    data.close();
  }
});
