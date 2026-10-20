import { afterEach, beforeEach, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Handlers } from "../src/handlers.js";
import { fixture, serverPath } from "./fixture.js";

let data: ReturnType<typeof fixture>, handlers: Handlers;
beforeEach(() => {
  data = fixture(4);
  const path = join(data.dir, "ideas.md");
  writeFileSync(
    path,
    "# Ideas\n\n🌍 **Attention** and care.\n\nFirst repeat. Second repeat.\n",
  );
  data.db.prepare("UPDATE documents SET path=? WHERE id='md'").run(path);
  data.db.exec("INSERT INTO settings VALUES('owner_name','Ada')");
  handlers = new Handlers(data.path, true);
  handlers.clientInfo = () => ({ name: "test-harness", version: "2.1.0" });
});
afterEach(() => data.close());

it("creates, edits across clients, deletes, records harnesses and enqueues durable outbox changes", async () => {
  data.db
    .exec(`INSERT INTO shares VALUES('active','md','key','token','url','2099-01-01','created',NULL,NULL);
    INSERT INTO shares VALUES('expired','md','key','token','url','2000-01-01','created',NULL,NULL);
    INSERT INTO shares VALUES('revoked','md','key','token','url','2099-01-01','created','revoked',NULL)`);
  const { annotation: a } = await handlers.createAnnotation({
    document_id: "md",
    quote: "Attention and care",
    note: "Keep",
  });
  expect(a).toMatchObject({
    source: "mcp",
    author_name: "Ada's agent",
    agent_client: "test-harness 2.1.0",
    start_offset: 9,
    end_offset: 27,
    color: "yellow",
    note: "Keep",
  });
  expect(
    data.db
      .prepare("SELECT author_id,author_name FROM annotations WHERE id=?")
      .get(a.id),
  ).toMatchObject({ author_id: null, author_name: null });
  expect(
    data.db
      .prepare(
        "SELECT share_id,deleted FROM share_outbox WHERE annotation_id=?",
      )
      .all(a.id),
  ).toEqual([{ share_id: "active", deleted: 0 }]);
  const other = new Handlers(data.path, true);
  other.clientInfo = () => ({ name: "another-harness", version: "3" });
  const edited = other.updateAnnotation({
    id: a.id,
    color: "purple",
    note: "Changed",
  }).annotation;
  expect(Date.parse(edited.updated_at)).toBeGreaterThan(
    Date.parse(a.updated_at),
  );
  expect(edited).toMatchObject({
    color: "purple",
    note: "Changed",
    agent_client: "another-harness 3",
  });
  expect(
    handlers.searchAnnotations({ query: "Changed" }).results[0].annotation.id,
  ).toBe(a.id);
  data.db.exec("UPDATE settings SET value='Alex' WHERE key='owner_name'");
  expect(handlers.getAnnotation({ id: a.id }).annotation.author_name).toBe(
    "Alex's agent",
  );
  expect(
    handlers.getDocumentAnnotations({
      document_id: "md",
      author: "Alex's agent",
    }).annotations,
  ).toHaveLength(1);
  expect(other.deleteAnnotation({ id: a.id })).toEqual({ deleted: true });
  expect(
    data.db
      .prepare("SELECT deleted FROM share_outbox WHERE annotation_id=?")
      .get(a.id)?.deleted,
  ).toBe(1);
  expect(
    data.db
      .prepare(
        "SELECT operation,agent_client FROM agent_writes WHERE annotation_id=? ORDER BY id",
      )
      .all(a.id),
  ).toEqual([
    { operation: "create", agent_client: "test-harness 2.1.0" },
    { operation: "update", agent_client: "another-harness 3" },
    { operation: "delete", agent_client: "another-harness 3" },
  ]);
  expect(handlers.searchAnnotations({ query: "Changed" }).results).toHaveLength(
    0,
  );
});

it("refuses owner/participant edits and deletes without changing their rows", () => {
  data.db.exec(
    "UPDATE annotations SET author_id='sam',author_name='Sam',source='share' WHERE id='p1'",
  );
  for (const id of ["m1", "p1", "missing"]) {
    expect(() => handlers.updateAnnotation({ id, note: "stolen" })).toThrow(
      "not an agent-authored annotation",
    );
    expect(() => handlers.deleteAnnotation({ id })).toThrow(
      "not an agent-authored annotation",
    );
  }
  expect(handlers.getAnnotation({ id: "m1" }).annotation.note).toBe(
    "Useful idea",
  );
  expect(
    data.db.prepare("SELECT count(*) AS n FROM agent_writes").get()?.n,
  ).toBe(0);
});

it("rejects missing/ambiguous quotes, disambiguates with context and caps input", async () => {
  await expect(
    handlers.createAnnotation({ document_id: "md", quote: "missing" }),
  ).rejects.toThrow("Quote not found");
  await expect(
    handlers.createAnnotation({ document_id: "md", quote: "repeat" }),
  ).rejects.toThrow("Ambiguous quote");
  const { annotation } = await handlers.createAnnotation({
    document_id: "md",
    quote: "repeat",
    prefix: "Second ",
  });
  expect(annotation.prefix).toContain("Second ");
  await expect(
    handlers.createAnnotation({ document_id: "md", quote: "a".repeat(2001) }),
  ).rejects.toThrow();
  await expect(
    handlers.createAnnotation({
      document_id: "md",
      quote: "Ideas",
      note: "🌍".repeat(8193),
    }),
  ).rejects.toThrow("32 KB");
  await expect(
    handlers.createAnnotation({
      document_id: "md",
      quote: "Ideas",
      model: "forbidden",
    }),
  ).rejects.toThrow("Unrecognized key");
  const readonly = new Handlers(data.path, false);
  await expect(
    readonly.createAnnotation({ document_id: "md", quote: "Ideas" }),
  ).rejects.toThrow("disabled");
  expect(() => readonly.deleteAnnotation({ id: annotation.id })).toThrow(
    "disabled",
  );
});

it("extracts rendered Markdown with DOM whitespace and UTF-16 pagination", async () => {
  const result = await handlers.getDocumentText({
    document_id: "md",
    limit: 10,
  });
  expect(result).toMatchObject({
    text: "Ideas\n🌍 A",
    offset: 0,
    next_offset: 10,
    base_offset: 0,
    page: null,
  });
  const rest = await handlers.getDocumentText({
    document_id: "md",
    offset: 10,
  });
  expect(result.text + rest.text).toBe(
    "Ideas\n🌍 Attention and care.\nFirst repeat. Second repeat.\n",
  );
  await expect(
    handlers.getDocumentText({ document_id: "md", page: 1 }),
  ).rejects.toThrow("page");
});

it("write mode rejects unmigrated databases before changing data", () => {
  data.db.exec("PRAGMA user_version=3");
  expect(() => handlers.updateAnnotation({ id: "m1", note: "no" })).toThrow(
    "expected 4; open the app to migrate",
  );
  expect(
    data.db.prepare("SELECT note FROM annotations WHERE id='m1'").get()?.note,
  ).toBe("Useful idea");
});

it("registers writes only in opt-in mode and captures real initialize clientInfo", async () => {
  const client = new Client({ name: "stdio-harness", version: "7.2" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ANNOPLAN_DB: data.path, ANNOPLAN_MCP_WRITE: "1" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(9);
    expect(
      tools.find((t) => t.name === "delete_annotation")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const result = await client.callTool({
      name: "create_annotation",
      arguments: { document_id: "md", quote: "Ideas" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      annotation: { source: "mcp", agent_client: "stdio-harness 7.2" },
    });
  } finally {
    await client.close();
  }
});
