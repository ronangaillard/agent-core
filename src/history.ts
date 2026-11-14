import { z } from "zod";
import type { Store } from "./store.ts";
import type { Scope, ToolDef } from "./types.ts";

type Exchange = ReturnType<Store["exchanges"]>[number];

/**
 * What was said in a private conversation never comes up elsewhere; the owner, in his own private conversation, sees
 * again what he said in private himself (never the private conversations of others with the agent).
 */
function visible(exchange: Exchange, scope: Scope, ownerId: string): boolean {
  if (!exchange.private) return true;
  return scope.owner && exchange.author_id === ownerId;
}

const cut = (text: unknown, max: number) => {
  const value = String(text ?? "").replace(/\s+/g, " ");
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const line = (e: Exchange, max: number) => {
  const output = cut(e.payload.output, max);
  const answer = e.payload.for_owner ? (output ? ` → you drafted for the owner: "${output}"` : "") : output ? ` → you: "${output}"` : " (you said nothing)";
  return `${e.payload.author ?? e.author_id}: "${cut(e.payload.input, max)}"${answer}`;
};

/** The agent's other recent conversations (72 h, 10 threads, 3 exchanges each), for the prompt. */
export function digest(store: Store, currentThread: string, scope: Scope, ownerId: string): string {
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();
  const threads = new Map<string, Exchange[]>();
  for (const exchange of store.exchanges(since)) {
    if (exchange.thread_key === currentThread || !visible(exchange, scope, ownerId)) continue;
    const list = threads.get(exchange.thread_key);
    if (!list && threads.size >= 10) continue;
    if (list && list.length >= 3) continue;
    threads.set(exchange.thread_key, [...(list ?? []), exchange]);
  }
  return [...threads.entries()]
    .map(([thread, list]) => `- ${list[0]?.payload.place ?? thread} [${thread}]\n${[...list].reverse().map((e) => `    ${line(e, 160)}`).join("\n")}`)
    .join("\n");
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Search everything the agent heard and said, within what the scope may recall. */
export function historyTools(store: Store, ownerId: string): ToolDef[] {
  return [
    {
      name: "search_conversations",
      description: "Search what you heard and said, beyond the <elsewhere> block: by keywords (all required) and/or a person.",
      input: { keywords: z.string().optional(), person: z.string().optional(), limit: z.number().int().min(1).max(30).optional() },
      rules: ["all"],
      run: async (args, { scope }) => {
        const words = fold(String(args.keywords ?? "")).split(/\s+/).filter((w) => w.length > 1);
        const person = args.person ? fold(String(args.person)) : "";
        if (!words.length && !person) return "Give keywords or a person.";
        const limit = Number(args.limit ?? 12);
        const found: string[] = [];
        for (const exchange of store.exchanges("0000", 5000)) {
          if (found.length >= limit) break;
          if (!visible(exchange, scope, ownerId)) continue;
          const haystack = fold(`${exchange.payload.author ?? ""} ${exchange.payload.place ?? ""} ${exchange.payload.input ?? ""} ${exchange.payload.output ?? ""}`);
          if (person && !haystack.includes(person)) continue;
          if (!words.every((w) => haystack.includes(w))) continue;
          found.push(`- ${exchange.at} ${exchange.payload.place ?? ""} [${exchange.thread_key}]: ${line(exchange, 300)}`);
        }
        return found.join("\n") || "Nothing found.";
      },
    },
  ];
}
