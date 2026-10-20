import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { extractText } from "./text.js";
import { createSelector, reanchor } from "./anchoring.js";
import { z } from "zod";

const color = z.enum(["yellow", "green", "blue", "pink", "purple"]);
const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  format: z.enum(["md", "pdf", "docx"]),
  annotation_count: z.number(),
  notes_count: z.number(),
  last_opened_at: z.string(),
});
const annotationSchema = z.object({
  id: z.string(),
  color,
  quote: z.string(),
  note: z.string().nullable(),
  author_name: z.string().nullable(),
  source: z.enum(["app", "mcp", "share"]),
  agent_client: z.string().nullable(),
  page: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const anchors = z.object({
  prefix: z.string(),
  suffix: z.string(),
  start_offset: z.number(),
  end_offset: z.number(),
  rects_json: z.string().nullable(),
});
const source = documentSchema.pick({ id: true, title: true, path: true });
const selector = {
  document_id: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
};
const requireSelector = (value: { document_id?: string; path?: string }) =>
  Boolean(value.document_id || value.path);

const note = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 32768,
    "note must be at most 32 KB",
  );
export const writeTools = new Set([
  "create_annotation",
  "update_annotation",
  "delete_annotation",
]);
export const inputs = {
  get_document_text: z.object({
    document_id: z.string().min(1),
    page: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20000).default(10000),
  }),
  create_annotation: z
    .object({
      document_id: z.string().min(1),
      quote: z.string().min(1).max(2000),
      prefix: z.string().max(2000).optional(),
      suffix: z.string().max(2000).optional(),
      note: note.optional(),
      color: color.default("yellow"),
      page: z.number().int().positive().optional(),
    })
    .strict(),
  update_annotation: z
    .object({
      id: z.string().min(1),
      note: note.nullable().optional(),
      color: color.optional(),
    })
    .strict()
    .refine(
      (value) => value.note !== undefined || value.color !== undefined,
      "Provide note or color",
    ),
  delete_annotation: z.object({ id: z.string().min(1) }).strict(),
  list_documents: z.object({
    query: z.string().optional(),
    format: z.enum(["md", "pdf", "docx"]).optional(),
    limit: z.number().int().min(1).max(1000).default(50),
  }),
  get_document_annotations: z
    .object({
      ...selector,
      color: color.optional(),
      author: z.string().nullable().optional(),
      with_notes_only: z.boolean().default(false),
      include_anchors: z.boolean().default(false),
    })
    .refine(requireSelector, "Provide document_id or path"),
  search_annotations: z.object({
    query: z.string().min(1),
    document_id: z.string().optional(),
    color: color.optional(),
    author: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(1000).default(20),
  }),
  get_annotation: z.object({ id: z.string().min(1) }),
  export_document_annotations: z
    .object({
      ...selector,
      format: z.literal("markdown"),
    })
    .refine(requireSelector, "Provide document_id or path"),
};
export const outputs = {
  get_document_text: z.object({
    page: z.number().nullable(),
    page_count: z.number(),
    base_offset: z.number(),
    offset: z.number(),
    total_chars: z.number(),
    next_offset: z.number().nullable(),
    text: z.string(),
  }),
  create_annotation: z.object({
    annotation: annotationSchema.extend(anchors.shape),
  }),
  update_annotation: z.object({
    annotation: annotationSchema.extend(anchors.shape),
  }),
  delete_annotation: z.object({ deleted: z.boolean() }),
  list_documents: z.object({ documents: z.array(documentSchema) }),
  get_document_annotations: z.object({
    document: documentSchema,
    annotations: z.array(annotationSchema.extend(anchors.partial().shape)),
  }),
  search_annotations: z.object({
    results: z.array(
      z.object({
        annotation: annotationSchema,
        document: source,
        snippet: z.string(),
      }),
    ),
  }),
  get_annotation: z.object({
    annotation: annotationSchema.extend(anchors.shape),
    document: documentSchema,
  }),
  export_document_annotations: z.object({ markdown: z.string() }),
};
export const descriptions = {
  get_document_text:
    "Read document text in UTF-16 offsets, rendered Markdown by default. PDF defaults to page 1; use page to read others. offset/limit paginate within the page. DOCX and PDF offsets are best effort; use exact quote context for anchoring.",
  create_annotation:
    "Create an agent highlight on an exact quote. Supply prefix/suffix to disambiguate duplicates, and page for PDFs. Only the shared agent identity can be edited by MCP.",
  update_annotation:
    "Edit an agent-authored highlight's note or color. Records this MCP client's name and version.",
  delete_annotation:
    "Delete an agent-authored highlight. Owner and participant highlights cannot be deleted by MCP.",
  list_documents:
    "List annoplan documents and highlight/note counts, newest opened first. Filter title/path by case-insensitive substring or by format.",
  get_document_annotations:
    "Read a document's highlights and notes in reading order. Supply a document_id or exact source path (symlinks resolved). Optionally filter color/notes and include anchor context.",
  search_annotations:
    "Search saved highlight quotes and notes using literal whitespace-separated terms combined with AND, ranked by relevance. This does not search full document text.",
  get_annotation:
    "Read one highlight by its public annotation id, including its note, document, and prefix/suffix anchor context.",
  export_document_annotations:
    "Get a Markdown digest of all highlights and notes for a document. Use this to summarise my notes on a document; supply document_id or source path.",
};
export type ToolName = keyof typeof inputs;

export function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((term) => '"' + term.replaceAll('"', '""') + '"')
    .join(" AND ");
}

const documentColumns = `d.id, d.title, d.path, d.format, d.last_opened_at,
 (SELECT count(*) FROM annotations a WHERE a.document_id=d.id) AS annotation_count,
 (SELECT count(*) FROM annotations a WHERE a.document_id=d.id AND a.note IS NOT NULL AND length(trim(a.note))>0) AS notes_count`;
const annotationColumns =
  "a.id, a.color, a.quote, a.note, a.page, a.created_at, a.updated_at, a.author_name";
const anchorColumns =
  "a.prefix, a.suffix, a.start_offset, a.end_offset, a.rects_json";
type Document = z.infer<typeof documentSchema>;
type Annotation = z.infer<typeof annotationSchema>;

export class Handlers {
  constructor(
    private readonly databasePath = process.env.ANNOPLAN_DB ??
      join(homedir(), "Library/Application Support/annoplan/annoplan.db"),
    readonly writable = process.env.ANNOPLAN_MCP_WRITE === "1",
  ) {}
  clientInfo: (() => { name: string; version: string } | undefined) | undefined;
  private agentClient() {
    const client = this.clientInfo?.();
    return client ? `${client.name} ${client.version}` : "unknown MCP client";
  }

  // A short-lived read transaction gives each call a consistent snapshot.
  // Closing it before returning lets the next call see newly committed app data.
  private read<T>(fn: (db: DatabaseSync) => T, write = false): T {
    if (write && !this.writable)
      throw new Error("MCP writes are disabled; set ANNOPLAN_MCP_WRITE=1");
    if (!existsSync(this.databasePath)) {
      throw new Error(
        `annoplan database not found at ${this.databasePath} — open the app once to create it`,
      );
    }
    const db = new DatabaseSync(this.databasePath, {
      readOnly: !this.writable,
    });
    try {
      db.exec(
        `PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; ${write ? "BEGIN IMMEDIATE" : "BEGIN"}`,
      );
      db.function("annoplan_realpath", { deterministic: true }, (value) => {
        try {
          return realpathSync(String(value));
        } catch {
          return String(value);
        }
      });
      db.function("annoplan_fold", { deterministic: true }, (value) =>
        String(value).toLowerCase(),
      );
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (
        this.writable
          ? version !== 4
          : version !== 2 && version !== 3 && version !== 4
      )
        throw new Error(
          `unsupported schema version ${version}; expected ${this.writable ? "4" : "2, 3 or 4"}; open the app to migrate`,
        );
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } finally {
      db.close();
    }
  }

  private annotationColumns(db: DatabaseSync) {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 4)
      return (
        annotationColumns.replace(
          "a.author_name",
          "CASE WHEN a.source='mcp' THEN coalesce((SELECT value FROM settings WHERE key='owner_name'),'Owner') || char(39) || 's agent' ELSE a.author_name END AS author_name",
        ) + ", a.source, a.agent_client"
      );
    return (
      (version === 2
        ? annotationColumns.replace("a.author_name", "NULL AS author_name")
        : annotationColumns) +
      (version === 2
        ? ", 'app' AS source"
        : ", CASE WHEN a.author_id IS NULL THEN 'app' ELSE 'share' END AS source") +
      ", NULL AS agent_client"
    );
  }
  private authorFilter(
    db: DatabaseSync,
    author: string | null,
    params: SQLInputValue[],
  ) {
    if (db.prepare("PRAGMA user_version").get()?.user_version === 2)
      return author === null ? "" : " AND 0";
    const label =
      db.prepare("PRAGMA user_version").get()?.user_version === 4
        ? "(CASE WHEN a.source='mcp' THEN coalesce((SELECT value FROM settings WHERE key='owner_name'),'Owner') || char(39) || 's agent' ELSE a.author_name END)"
        : "a.author_name";
    if (author === null) return ` AND ${label} IS NULL`;
    params.push(author);
    return ` AND ${label}=?`;
  }

  private document(
    db: DatabaseSync,
    input: { document_id?: string; path?: string },
  ): Document {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (input.document_id) {
      conditions.push("d.id=?");
      params.push(input.document_id);
    }
    if (input.path) {
      let resolved = input.path;
      try {
        resolved = realpathSync(input.path);
      } catch {
        /* Stored paths can outlive source files. */
      }
      conditions.push("(d.path=? OR annoplan_realpath(d.path)=?)");
      params.push(input.path, resolved);
    }
    const row = db
      .prepare(
        `SELECT ${documentColumns} FROM documents d WHERE ${conditions.join(" AND ")}`,
      )
      .get(...params);
    if (!row)
      throw new Error(
        "Document not found (document_id and path must match when both are supplied)",
      );
    return documentSchema.parse(row);
  }

  async getDocumentText(raw: unknown) {
    const input = inputs.get_document_text.parse(raw);
    const document = this.read((db) => this.document(db, input));
    const pages = await extractText(document.path, document.format);
    const page = pages.find(
      (p) => p.page === (document.format === "pdf" ? (input.page ?? 1) : null),
    );
    if (!page || (document.format !== "pdf" && input.page !== undefined))
      throw new Error("page is only supported for PDF and must exist");
    return {
      page: page.page,
      page_count: pages.length,
      base_offset: page.base_offset,
      offset: input.offset,
      total_chars: page.text.length,
      next_offset:
        input.offset + input.limit < page.text.length
          ? input.offset + input.limit
          : null,
      text: page.text.slice(input.offset, input.offset + input.limit),
    };
  }
  async createAnnotation(raw: unknown) {
    if (!this.writable)
      throw new Error("MCP writes are disabled; set ANNOPLAN_MCP_WRITE=1");
    const input = inputs.create_annotation.parse(raw);
    const document = this.read((db) => this.document(db, input));
    const pages = await extractText(document.path, document.format);
    if (input.page !== undefined && document.format !== "pdf")
      throw new Error("page is only supported for PDF");
    const candidates = pages.filter(
      (p) => input.page === undefined || p.page === input.page,
    );
    // Reuse the viewer's scoring across the whole document so duplicate quotes
    // on different PDF pages are also ambiguous unless page/context selects one.
    const combined = candidates.map((p) => p.text).join("");
    if (!combined.includes(input.quote))
      throw new Error(
        "Quote not found in extracted document text; use get_document_text to choose an exact quote",
      );
    const anchor = reanchor(combined, {
      quote: input.quote,
      prefix: input.prefix ?? "",
      suffix: input.suffix ?? "",
      start_offset: -1,
      end_offset: -1,
    });
    if (!anchor)
      throw new Error(
        "Ambiguous quote; provide more prefix/suffix context or a PDF page",
      );
    let localStart = anchor.start;
    let page = candidates[0];
    for (const candidate of candidates) {
      page = candidate;
      if (localStart < candidate.text.length) break;
      localStart -= candidate.text.length;
    }
    if (localStart + input.quote.length > page.text.length)
      throw new Error(
        "Quote crosses PDF pages; select a quote within one page",
      );
    const selector = createSelector(
      page.text,
      localStart,
      localStart + input.quote.length,
    );
    const id = randomUUID(),
      timestamp = new Date().toISOString();
    this.read((db) => {
      db.prepare(
        `INSERT INTO annotations(id,document_id,color,quote,prefix,suffix,start_offset,end_offset,page,note,created_at,updated_at,source,agent_client) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'mcp',?)`,
      ).run(
        id,
        document.id,
        input.color,
        input.quote,
        selector.prefix,
        selector.suffix,
        selector.start_offset + page.base_offset,
        selector.end_offset + page.base_offset,
        page.page,
        input.note ?? null,
        timestamp,
        timestamp,
        this.agentClient(),
      );
      this.logWrite(db, id, "create");
    }, true);
    return { annotation: this.getAnnotation({ id }).annotation };
  }
  updateAnnotation(raw: unknown) {
    const input = inputs.update_annotation.parse(raw);
    this.read((db) => {
      this.requireAgent(db, input.id);
      const previous = db
        .prepare("SELECT updated_at FROM annotations WHERE id=?")
        .get(input.id);
      const timestamp = new Date(
        Math.max(Date.now(), Date.parse(String(previous?.updated_at)) + 1),
      ).toISOString();
      const sets = ["updated_at=?", "agent_client=?"],
        values: SQLInputValue[] = [timestamp, this.agentClient()];
      if (input.note !== undefined) {
        sets.push("note=?");
        values.push(input.note);
      }
      if (input.color !== undefined) {
        sets.push("color=?");
        values.push(input.color);
      }
      db.prepare(`UPDATE annotations SET ${sets.join(",")} WHERE id=?`).run(
        ...values,
        input.id,
      );
      this.logWrite(db, input.id, "update");
    }, true);
    return { annotation: this.getAnnotation(input).annotation };
  }
  deleteAnnotation(raw: unknown) {
    const { id } = inputs.delete_annotation.parse(raw);
    this.read((db) => {
      this.requireAgent(db, id);
      this.logWrite(db, id, "delete");
      db.prepare("DELETE FROM annotations WHERE id=?").run(id);
    }, true);
    return { deleted: true };
  }
  private logWrite(db: DatabaseSync, id: string, operation: string) {
    db.prepare(
      "INSERT INTO agent_writes(annotation_id,operation,agent_client,written_at) VALUES(?,?,?,?)",
    ).run(id, operation, this.agentClient(), new Date().toISOString());
  }
  private requireAgent(db: DatabaseSync, id: string) {
    if (
      db.prepare("SELECT source FROM annotations WHERE id=?").get(id)
        ?.source !== "mcp"
    )
      throw new Error("not an agent-authored annotation");
  }

  listDocuments(raw: unknown = {}) {
    const input = inputs.list_documents.parse(raw);
    return this.read((db) => {
      const conditions: string[] = [];
      const params: SQLInputValue[] = [];
      if (input.query !== undefined) {
        conditions.push(
          "(instr(annoplan_fold(d.title),annoplan_fold(?))>0 OR instr(annoplan_fold(d.path),annoplan_fold(?))>0)",
        );
        params.push(input.query, input.query);
      }
      if (input.format) {
        conditions.push("d.format=?");
        params.push(input.format);
      }
      params.push(input.limit);
      return {
        documents: z.array(documentSchema).parse(
          db
            .prepare(
              `SELECT ${documentColumns} FROM documents d ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
         ORDER BY d.last_opened_at DESC, d.id LIMIT ?`,
            )
            .all(...params),
        ),
      };
    });
  }

  documentsResource() {
    return this.read((db) =>
      z
        .array(documentSchema)
        .parse(
          db
            .prepare(
              `SELECT ${documentColumns} FROM documents d ORDER BY d.last_opened_at DESC, d.id`,
            )
            .all(),
        ),
    );
  }

  getDocumentAnnotations(raw: unknown) {
    const input = inputs.get_document_annotations.parse(raw);
    return this.read((db) => {
      const document = this.document(db, input);
      const params: SQLInputValue[] = [document.id];
      let where = "a.document_id=?";
      if (input.color) {
        where += " AND a.color=?";
        params.push(input.color);
      }
      if (input.author !== undefined)
        where += this.authorFilter(db, input.author, params);
      if (input.with_notes_only)
        where += " AND a.note IS NOT NULL AND length(trim(a.note))>0";
      const annotations = db
        .prepare(
          `SELECT ${this.annotationColumns(db)}${input.include_anchors ? ", " + anchorColumns : ""}
        FROM annotations a WHERE ${where} ORDER BY a.page, a.start_offset, a.id`,
        )
        .all(...params);
      return outputs.get_document_annotations.parse({ document, annotations });
    });
  }

  searchAnnotations(raw: unknown) {
    const input = inputs.search_annotations.parse(raw);
    return this.read((db) => {
      const query = sanitizeFtsQuery(input.query);
      if (!query) return { results: [] };
      const params: SQLInputValue[] = [query];
      let where = "annotations_fts MATCH ?";
      if (input.document_id) {
        where += " AND a.document_id=?";
        params.push(input.document_id);
      }
      if (input.color) {
        where += " AND a.color=?";
        params.push(input.color);
      }
      if (input.author !== undefined)
        where += this.authorFilter(db, input.author, params);
      params.push(input.limit);
      const rows = db
        .prepare(
          `SELECT ${this.annotationColumns(db)}, d.id AS document_id, d.title, d.path,
        snippet(annotations_fts,-1,'[',']',' … ',24) AS snippet
        FROM annotations_fts JOIN annotations a ON a.seq=annotations_fts.rowid
        JOIN documents d ON d.id=a.document_id WHERE ${where}
        ORDER BY bm25(annotations_fts), a.id LIMIT ?`,
        )
        .all(...params);
      return outputs.search_annotations.parse({
        results: rows.map((row) => ({
          annotation: row,
          document: { id: row.document_id, title: row.title, path: row.path },
          snippet: row.snippet,
        })),
      });
    });
  }

  getAnnotation(raw: unknown) {
    const { id } = inputs.get_annotation.parse(raw);
    return this.read((db) => {
      const annotation = db
        .prepare(
          `SELECT ${this.annotationColumns(db)}, ${anchorColumns}, a.document_id FROM annotations a WHERE a.id=?`,
        )
        .get(id);
      if (!annotation) throw new Error(`Annotation not found: ${id}`);
      return outputs.get_annotation.parse({
        annotation,
        document: this.document(db, {
          document_id: String(annotation.document_id),
        }),
      });
    });
  }

  exportDocumentAnnotations(raw: unknown) {
    const input = inputs.export_document_annotations.parse(raw);
    const { document, annotations } = this.getDocumentAnnotations(input);
    return { markdown: markdownDigest(document, annotations) };
  }
}

function markdownDigest(document: Document, annotations: Annotation[]): string {
  return [
    "# " + document.title.replace(/[\r\n]+/g, " "),
    "",
    "Source: " + document.path,
    "",
    `${annotations.length} highlights · ${document.notes_count} ${document.notes_count === 1 ? "note" : "notes"}`,
    ...annotations.flatMap((annotation) => [
      "",
      annotation.quote
        .split(/\r?\n/)
        .map((line) => "> " + line)
        .join("\n"),
      ...(annotation.note?.trim() ? ["", annotation.note] : []),
      ...(document.format === "pdf" && annotation.page !== null
        ? ["", `p. ${annotation.page}`]
        : []),
      ...(annotation.author_name
        ? ["", `Author: ${annotation.author_name.replace(/[\r\n]+/g, " ")}`]
        : []),
    ]),
    "",
  ].join("\n");
}

export function invoke(handlers: Handlers, name: ToolName, input: unknown) {
  try {
    const structuredContent = (() => {
      switch (name) {
        case "get_document_text":
          return handlers.getDocumentText(input);
        case "create_annotation":
          return handlers.createAnnotation(input);
        case "update_annotation":
          return handlers.updateAnnotation(input);
        case "delete_annotation":
          return handlers.deleteAnnotation(input);
        case "list_documents":
          return handlers.listDocuments(input);
        case "get_document_annotations":
          return handlers.getDocumentAnnotations(input);
        case "search_annotations":
          return handlers.searchAnnotations(input);
        case "get_annotation":
          return handlers.getAnnotation(input);
        case "export_document_annotations":
          return handlers.exportDocumentAnnotations(input);
      }
    })();
    const success = (value: Record<string, unknown>) => ({
      content: [
        {
          type: "text" as const,
          text:
            typeof value.markdown === "string"
              ? value.markdown
              : JSON.stringify(value, null, 2),
        },
      ],
      structuredContent: value,
    });
    if (structuredContent instanceof Promise)
      return structuredContent.then(success).catch(toolError);
    return success(structuredContent);
  } catch (error) {
    return toolError(error);
  }
}
function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: { error: message },
  };
}
