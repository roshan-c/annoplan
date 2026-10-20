// Read-only smoke check through the actual stdio protocol. No client config changes.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const client = new Client({ name: "annoplan-db-check", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  env: { ...process.env },
  stderr: "inherit",
});
try {
  await client.connect(transport);
  console.log(
    "Tools:",
    (await client.listTools()).tools.map((tool) => tool.name).join(", "),
  );
  const result = await client.callTool({
    name: "list_documents",
    arguments: {},
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
