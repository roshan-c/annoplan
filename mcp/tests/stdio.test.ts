import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture, serverPath } from "./fixture.js";

it("advertises six typed read-only tools and resources, and executes search over stdio", async () => {
  const data = fixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ANNOPLAN_DB: data.path, ANNOPLAN_MCP_WRITE: "0" },
    stderr: "pipe",
  });
  const client = new Client({ name: "annoplan-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "export_document_annotations",
      "get_annotation",
      "get_document_annotations",
      "get_document_text",
      "list_documents",
      "search_annotations",
    ]);
    for (const tool of tools) {
      expect(tool.outputSchema).toHaveProperty("type", "object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    const result = await client.callTool({
      name: "search_annotations",
      arguments: { query: '"please"!' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          annotation: { id: "p2" },
          document: { id: "pdf" },
          snippet: expect.stringContaining("[please]"),
        },
      ],
    });
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("[please]") },
    ]);
    const annotations = await client.callTool({
      name: "get_document_annotations",
      arguments: { document_id: "pdf" },
    });
    expect(annotations.isError).not.toBe(true);
    expect(annotations.structuredContent).toMatchObject({
      annotations: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    });
    const invalid = await client.callTool({
      name: "get_document_annotations",
      arguments: {},
    });
    expect(invalid.isError).toBe(true);
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain(
      "annoplan://documents",
    );
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates[0].uriTemplate).toBe(
      "annoplan://documents/{id}/annotations",
    );
    expect(
      (await client.readResource({ uri: "annoplan://documents" })).contents[0],
    ).toMatchObject({
      mimeType: "application/json",
      text: expect.stringContaining("Research Paper"),
    });
    expect(
      (
        await client.readResource({
          uri: "annoplan://documents/pdf/annotations",
        })
      ).contents[0],
    ).toMatchObject({
      mimeType: "text/markdown",
      text: expect.stringContaining("# Research Paper"),
    });
    data.db.exec("PRAGMA user_version=99");
    const error = await client.callTool({
      name: "list_documents",
      arguments: {},
    });
    expect(error).toMatchObject({
      isError: true,
      structuredContent: {
        error:
          "unsupported schema version 99; expected 2, 3 or 4; open the app to migrate",
      },
    });
  } finally {
    await client.close();
    data.close();
  }
}, 15000);
