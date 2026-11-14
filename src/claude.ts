import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { TransientError, type Brain } from "./types.ts";

/** Worth retrying later: overload, rate limit, network. Anything else counts as a failure. */
const TRANSIENT = /overloaded|529|rate.?limit|429|\b50[0-4]\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

const classify = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT.test(message) ? new TransientError(message) : error;
};

/** Claude Code rejects the draft 2020-12 `$schema` marker zod adds. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _marker, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * The model through the Claude Agent SDK. Step 1: no tools, a structured answer. No session on the model side: the
 * prompt is rebuilt at each call.
 */
export function claudeBrain(options: { model?: string; executable?: string } = {}): Brain {
  return async ({ system, prompt, schema }) => {
    try {
      const conversation = query({
        prompt,
        options: {
          systemPrompt: system,
          ...(options.model ? { model: options.model } : {}),
          ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
          tools: [],
          allowedTools: [],
          permissionMode: "dontAsk",
          settingSources: [],
          persistSession: false,
          maxTurns: 3,
          outputFormat: { type: "json_schema", schema: jsonSchema(schema) },
        },
      });
      for await (const message of conversation) {
        if (message.type !== "result") continue;
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
