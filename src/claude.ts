import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { TransientError, type Brain } from "./types.ts";

/** Worth retrying later: overload, rate limit, network. Anything else counts as a failure. */
const TRANSIENT = /overloaded|rate.?limit|(?:status|code|http|error)[^0-9]{0,12}\b(?:429|529|50[0-4])\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

const classify = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT.test(message) ? new TransientError(message) : error;
};

/** Claude Code rejects the draft 2020-12 `$schema` marker zod adds. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _marker, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

const SERVER = "agent";

const controllerOf = (signal: AbortSignal) => {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
};

/**
 * The model through the Claude Agent SDK, with a structured answer. The tools are an in-process MCP server built for
 * this call: the model sees only those the scope allows (dontAsk refuses everything else), and no built-in tool. No
 * session on the model side: the prompt is rebuilt at each call.
 */
export function claudeBrain(options: { model?: string; executable?: string; maxTurns?: number } = {}): Brain {
  return async ({ system, prompt, schema, tools = [], signal, onRun }) => {
    try {
      const server =
        tools.length > 0
          ? createSdkMcpServer({
              name: SERVER,
              version: "1.0.0",
              tools: tools.map((t) =>
                tool(t.name, t.description, t.input, async (args: Record<string, unknown>) => {
                  try {
                    const result = await t.run(args);
                    if (typeof result === "string") return { content: [{ type: "text" as const, text: result }] };
                    return { content: [{ type: "text" as const, text: result.text }, { type: "image" as const, data: result.image.data, mimeType: result.image.mime }] };
                  } catch (error) {
                    return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
                  }
                }),
              ),
            })
          : undefined;
      const conversation = query({
        prompt,
        options: {
          systemPrompt: system,
          ...(options.model ? { model: options.model } : {}),
          ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
          tools: [],
          mcpServers: server ? { [SERVER]: server } : {},
          allowedTools: tools.map((t) => `mcp__${SERVER}__${t.name}`),
          permissionMode: "dontAsk",
          settingSources: [],
          persistSession: false,
          // The core's deadline: aborting stops the Claude Code process too.
          ...(signal ? { abortController: controllerOf(signal) } : {}),
          maxTurns: tools.length > 0 ? (options.maxTurns ?? 20) : 3,
          outputFormat: { type: "json_schema", schema: jsonSchema(schema) },
        },
      });
      for await (const message of conversation) {
        // The tools' server not connected at start: the model would run without its tools and say so. Nothing done
        // yet, so a later try is safe.
        if (server && message.type === "system" && message.subtype === "init") {
          const status = message.mcp_servers.find((s) => s.name === SERVER)?.status ?? "absent";
          if (status !== "connected") {
            console.warn(`model: the tools are not connected (${status}), tried again later`);
            throw new TransientError(`the tools are not connected (${status})`);
          }
        }
        if (message.type !== "result") continue;
        onRun?.({ turns: message.num_turns, cost_usd: message.total_cost_usd, ms: message.duration_ms, outcome: message.subtype });
        if (message.subtype !== "success" || message.is_error) {
          throw new Error(`model failed (${message.subtype})${"result" in message ? ` : ${message.result}` : ""}`);
        }
        return message.structured_output;
      }
      throw new Error("the model stopped without a result");
    } catch (error) {
      throw classify(error);
    }
  };
}
