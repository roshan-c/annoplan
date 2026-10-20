import { z } from "zod";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Handlers,
  descriptions,
  inputs,
  invoke,
  outputs,
  writeTools,
  type ToolName,
} from "./handlers.js";

export function createServer(handlers = new Handlers()) {
  const server = new McpServer({ name: "annoplan", version: "0.1.0" });
  handlers.clientInfo = () => server.server.getClientVersion();
  for (const name of Object.keys(inputs) as ToolName[]) {
    if (writeTools.has(name) && !handlers.writable) continue;
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema: inputs[name], // Errors have structured content too; success fields are absent on errors.
        outputSchema: outputs[name]
          .partial()
          .extend({ error: z.string().optional() }),
        annotations: {
          readOnlyHint: !writeTools.has(name),
          destructiveHint: name === "delete_annotation",
          openWorldHint: false,
        },
      },
      (input: unknown) => invoke(handlers, name, input),
    );
  }
  server.registerResource(
    "documents",
    "annoplan://documents",
    {
      description:
        "All saved annoplan documents with highlight and note counts.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(handlers.documentsResource(), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    "document-annotations",
    new ResourceTemplate("annoplan://documents/{id}/annotations", {
      list: undefined,
    }),
    {
      description: "Markdown digest of a document's highlights and notes.",
      mimeType: "text/markdown",
    },
    (uri, { id }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: handlers.exportDocumentAnnotations({
            document_id: id,
            format: "markdown",
          }).markdown,
        },
      ],
    }),
  );
  return server;
}
