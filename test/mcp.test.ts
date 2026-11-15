import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { mcpTools } from "../src/mcp.ts";

/** A remote MCP server, stateless, that records the Authorization header it gets. */
async function fakeServer(): Promise<{ url: string; auth: string[]; close: () => Promise<void> }> {
  const auth: string[] = [];
  const http: Server = createServer(async (req, res) => {
    auth.push(String(req.headers.authorization));
    const mcp = new McpServer({ name: "fake", version: "1.0.0" });
    mcp.registerTool("search", { description: "Search pages", inputSchema: { query: z.string().describe("words") }, annotations: { readOnlyHint: true } }, async ({ query }) => ({
      content: [{ type: "text", text: `found: ${query}` }],
    }));
    mcp.registerTool("create-page", { description: "Create a page", inputSchema: { title: z.string() } }, async ({ title }) =>
      title === "bad" ? { content: [{ type: "text", text: "no rights" }], isError: true } : { content: [{ type: "text", text: `created ${title}` }] },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, auth, close: () => new Promise((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }) };
}

test("mcp: a remote server's tools become the agent's, read-only ones without effect, its token from the environment", async () => {
  const server = await fakeServer();
  const logs: string[] = [];
  const tools = await mcpTools({ notion: { url: server.url, headers: { Authorization: "Bearer ${FAKE_TOKEN}" } } }, { env: { FAKE_TOKEN: "t0k" }, log: (line) => logs.push(line) });
  assert.deepEqual(tools.map((t) => [t.name, t.effect, t.rules]), [
    ["search", false, ["all"]],
    ["create-page", true, ["all"]],
  ]);
  assert.ok(Object.keys(tools[0]!.input).includes("query"));
  const context = { scope: { owner: false, requester: "paul", private: false }, threadKey: "x", lotIds: [], connector: "fake", address: { connector: "fake", conversation: "c", thread: "main" } };
  assert.equal(await tools[0]!.run({ query: "budget" }, context), "found: budget");
  assert.equal(await tools[1]!.run({ title: "Notes" }, context), "created Notes");
  await assert.rejects(tools[1]!.run({ title: "bad" }, context), /no rights/);
  assert.ok(server.auth.every((a) => a === "Bearer t0k"));
  assert.match(logs.join("\n"), /mcp notion: 2 tools/);
  await server.close();
});

test("mcp: a server down at start, or a token missing, is left out without stopping the agent", async () => {
  const logs: string[] = [];
  const tools = await mcpTools(
    { down: { url: "http://127.0.0.1:1/mcp" }, notoken: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer ${MISSING}" } } },
    { env: {}, log: (line) => logs.push(line) },
  );
  assert.deepEqual(tools, []);
  assert.match(logs.join("\n"), /mcp down: left out/);
  assert.match(logs.join("\n"), /mcp notoken: left out \(MISSING is not set\)/);
});

test("mcp: an oauth sign-in is kept in a file only its owner reads, the pending step cleared once signed in", async () => {
  const { mkdtempSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FileAuth } = await import("../src/mcp-auth.ts");
  const dir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
  const auth = new FileAuth(dir, "notion");
  assert.equal(auth.tokens(), undefined);
  assert.throws(() => auth.codeVerifier(), /no sign-in in progress/);
  auth.saveClientInformation({ client_id: "c1" });
  auth.saveCodeVerifier("v1");
  auth.redirectToAuthorization(new URL("https://example.com/authorize?x=1"));
  assert.equal(auth.load().pending, "https://example.com/authorize?x=1");
  assert.equal(auth.codeVerifier(), "v1");
  auth.saveTokens({ access_token: "a", token_type: "bearer", refresh_token: "r" });
  assert.deepEqual(auth.load(), { client: { client_id: "c1" }, tokens: { access_token: "a", token_type: "bearer", refresh_token: "r" } });
  assert.equal(statSync(join(dir, "notion.json")).mode & 0o777, 0o600);
});
