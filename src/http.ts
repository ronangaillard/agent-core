import { z } from "zod";
import { allows } from "./access.ts";
import { expand } from "./mcp.ts";
import type { Rule, ToolDef } from "./types.ts";

/**
 * An HTTP API the agent may call: its base URL, its headers (${VAR} taken from the environment, so a token is added
 * by the code and never seen by the model), who may use it, and a line telling the model what it is for.
 */
export type HttpApiConfig = { url: string; description?: string; headers?: Record<string, string>; rules?: Rule[] };

const TEXT_MAX = 50_000;
const TIMEOUT_MS = 30_000;

/**
 * http_get and http_send: calls to the listed APIs only. The model names an API and a path, never a host: the URL is
 * the API's base plus the path, refused if it leaves the base. GET reads; POST, PUT, PATCH, DELETE are an effect.
 */
export function httpTools(apis: Record<string, HttpApiConfig>, { env = process.env, fetch: get = fetch }: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): ToolDef[] {
  const names = Object.keys(apis);
  if (names.length === 0) return [];
  for (const api of Object.values(apis)) for (const value of Object.values(api.headers ?? {})) expand(value, env); // a missing ${VAR} stops the start
  const listed = names.map((name) => `- ${name}: ${apis[name]!.url}${apis[name]!.description ? `, ${apis[name]!.description}` : ""}`).join("\n");
  const api = z.enum(names as [string, ...string[]]).describe("which API");
  const path = z.string().describe('the path after the base URL, with its query string, e.g. "/api/scrabble?x=1"');

  const call = async (args: Record<string, unknown>, scope: Parameters<typeof allows>[1], method: string) => {
    const config = apis[String(args.api)];
    if (!config) return `${String(args.api)}: no such API.`;
    if (!allows(config.rules ?? ["all"], scope)) return `${String(args.api)}: not allowed here.`;
    const base = new URL(config.url.endsWith("/") ? config.url : `${config.url}/`);
    const url = new URL(String(args.path ?? "").replace(/^\/+/, ""), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return `${String(args.path)}: outside ${config.url}.`;
    const headers: Record<string, string> = Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, expand(value, env)]));
    let body: string | undefined;
    if (args.body !== undefined) {
      body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
      if (typeof args.body !== "string") headers["Content-Type"] ??= "application/json";
    }
    const res = await get(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    let text = await res.text();
    if (text.length > TEXT_MAX) text = `${text.slice(0, TEXT_MAX)}\n…(cut)`;
    return `HTTP ${res.status}\n${text || "(empty)"}`;
  };

  return [
    {
      name: "http_get",
      description: `GET on one of these APIs (the token, if any, is added for you):\n${listed}`,
      input: { api, path },
      rules: ["all"],
      run: (args, context) => call(args, context.scope, "GET"),
    },
    {
      name: "http_send",
      description: `POST, PUT, PATCH or DELETE on one of these APIs (the token, if any, is added for you):\n${listed}`,
      input: {
        api,
        path,
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        body: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]).optional().describe("JSON (an object or an array) or raw text"),
      },
      rules: ["all"],
      effect: true,
      run: (args, context) => call(args, context.scope, String(args.method)),
    },
  ];
}
