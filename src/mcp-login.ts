/**
 * Signs the agent in to an MCP server declared with oauth in AGENT_MCP_SERVERS, in two steps, in the container:
 *
 *   tsx src/mcp-login.ts notion                  → prints the address to open in a browser, signed in to the service
 *   tsx src/mcp-login.ts notion '<address>'      → the address the browser ends on (localhost…?code=…): signed in
 *
 * The tokens go to AGENT_MCP_AUTH/<name>.json; the agent loads the server's tools at its next start.
 */
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FileAuth } from "./mcp-auth.ts";
import { transportOf, type McpServerConfig } from "./mcp.ts";

const [name, back] = process.argv.slice(2);
const servers = JSON.parse(process.env.AGENT_MCP_SERVERS ?? "{}") as Record<string, McpServerConfig>;
const server = name ? servers[name] : undefined;
if (!name || !server?.oauth) {
  console.error(`usage: mcp-login.ts <name> [address]; servers with oauth: ${Object.keys(servers).filter((n) => servers[n]!.oauth).join(", ") || "none"}`);
  process.exit(2);
}
const authDir = process.env.AGENT_MCP_AUTH ?? "data/mcp-auth";
const transport = transportOf(name, server, { authDir });
const client = new Client({ name: "agent-core", version: "1.0.0" });

if (back) {
  const code = new URL(back.trim()).searchParams.get("code");
  if (!code) throw new Error("no code in this address");
  await transport.finishAuth(code);
  await client.connect(transportOf(name, server, { authDir }));
  console.log(`signed in to ${name}: ${(await client.listTools()).tools.length} tools. Restart the agent to load them.`);
} else {
  try {
    await client.connect(transport);
    console.log(`already signed in to ${name}: ${(await client.listTools()).tools.length} tools.`);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    console.log(`Open this address, allow, then run again with the address the browser ends on:\n${new FileAuth(authDir, name).load().pending}`);
  }
}
await client.close();
