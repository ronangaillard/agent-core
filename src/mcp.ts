import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { FileAuth } from "./mcp-auth.ts";
import type { Rule, ToolDef, ToolResult } from "./types.ts";

/**
 * A remote MCP server: its URL, its headers (${VAR} taken from the environment), who may use its tools. oauth: signed
 * in once by hand (mcp-login.ts), the tokens kept in the auth folder and refreshed.
 */
export type McpServerConfig = { url: string; headers?: Record<string, string>; oauth?: boolean; rules?: Rule[] };
export type McpOptions = { env?: NodeJS.ProcessEnv; log?: (line: string) => void; authDir?: string };

/** What a tool may hand back to the model, at most. */
const TEXT_MAX = 50_000;

/** The transport to one server, with its headers and its sign-in. */
export function transportOf(name: string, server: McpServerConfig, { env = process.env, authDir = "data/mcp-auth" }: McpOptions = {}) {
  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key, expand(value, env)]));
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers }, ...(server.oauth ? { authProvider: new FileAuth(authDir, name) } : {}) });
}

const expand = (value: string, env: NodeJS.ProcessEnv) =>
  value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined) throw new Error(`${name} is not set`);
    return found;
  });

/**
 * The tools of remote MCP servers, as the agent's own tools: bound by rules, traced, kept from owner drafts when
 * they change something. All of a server's tools, with the rights of its token. A tool the server does not mark
 * read-only counts as an effect. The connection is opened again when a call fails; a server down at start is left
 * out (logged) rather than stopping the agent.
 */
export async function mcpTools(servers: Record<string, McpServerConfig>, options: McpOptions = {}): Promise<ToolDef[]> {
  const log = options.log ?? console.error;
  const tools: ToolDef[] = [];
  for (const [name, server] of Object.entries(servers)) {
    try {
      transportOf(name, server, options); // a missing ${VAR}: left out now, not at the first call
      let client: Promise<Client> | undefined;
      const connect = () =>
        (client ??= (async () => {
          const c = new Client({ name: "agent-core", version: "1.0.0" });
          await c.connect(transportOf(name, server, options));
          return c;
        })().catch((error: unknown) => {
          client = undefined;
          throw error;
        }));
      const listed = await (await connect()).listTools();
      for (const tool of listed.tools) {
        let input: z.ZodRawShape;
        try {
          input = (z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject).shape;
        } catch (error) {
          log(`mcp ${name}: ${tool.name} left out, its input schema is not understood (${error instanceof Error ? error.message : String(error)})`);
          continue;
        }
        tools.push({
          name: tool.name,
          description: tool.description ?? tool.title ?? tool.name,
          input,
          rules: server.rules ?? ["all"],
          effect: tool.annotations?.readOnlyHint !== true,
          run: async (args) => {
            let result;
            try {
              result = await (await connect()).callTool({ name: tool.name, arguments: args });
            } catch (error) {
              // The session may have dropped: the next call connects again. Not retried here: it may have written.
              void client?.then((c) => c.close()).catch(() => undefined);
              client = undefined;
              throw error;
            }
            const content = (result.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string }[];
            let text = content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
            if (text.length > TEXT_MAX) text = `${text.slice(0, TEXT_MAX)}\n…(cut)`;
            if (result.isError) throw new Error(text || "the tool failed");
            const image = content.find((c) => c.type === "image" && c.data && c.mimeType);
            const out: ToolResult = image ? { text, image: { data: image.data!, mime: image.mimeType! } } : text || "(empty)";
            return out;
          },
        });
      }
      log(`mcp ${name}: ${listed.tools.length} tools`);
    } catch (error) {
      const unsigned = error instanceof UnauthorizedError;
      log(`mcp ${name}: left out (${unsigned ? `not signed in: node_modules/.bin/tsx src/mcp-login.ts ${name}` : error instanceof Error ? error.message : String(error)})`);
    }
  }
  return tools;
}
