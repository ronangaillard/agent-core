import { z } from "zod";
import type { Store } from "./store.ts";
import { localTime, mayRecall, type Privacy, type Scope, type ToolDef } from "./types.ts";

type Exchange = ReturnType<Store["exchanges"]>[number];

/** What this conversation may recall of an exchange: the privacy rule (see Privacy). */
function visible(exchange: Exchange, scope: Scope, privacy: Privacy): boolean {
  // What waits for the owner (a draft in his name, a held reply) is his alone, approved or not; he sees all of it,
  // private or not, as he was told of each one when it was held.
  if (exchange.payload.for_owner || exchange.payload.held) return scope.owner;
  return mayRecall({ private: exchange.private, author: exchange.author_id }, scope, privacy);
}

const cut = (text: unknown, max: number) => {
  const value = String(text ?? "").replace(/\s+/g, " ");
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const line = (e: Exchange, max: number) => {
  const output = cut(e.payload.output, max);
  const reacted = e.payload.reaction ? ` (you reacted :${String(e.payload.reaction)}:)` : "";
  const answer = e.payload.for_owner ? (output ? ` → you drafted for the owner: "${output}"` : "") : output ? ` → you: "${output}"${reacted}` : reacted || " (you said nothing)";
  return `${localTime(e.at)}${e.ref ? ` message:${e.ref}` : ""} ${e.payload.author ?? e.author_id}: "${cut(e.payload.input, max)}"${answer}`;
};

/** The agent's other recent conversations (72 h, 10 threads, 3 exchanges each, cut), for the prompt. */
export function digest(store: Store, currentThread: string, scope: Scope, privacy: Privacy): string {
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();
  const threads = new Map<string, Exchange[]>();
  for (const exchange of store.exchanges(since)) {
    if (exchange.thread_key === currentThread || !visible(exchange, scope, privacy)) continue;
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
export function historyTools(store: Store, privacy: Privacy): ToolDef[] {
  return [
    {
      name: "search_conversations",
      description: "Search what you heard and said, beyond the <elsewhere> block: by keywords (all required) and/or a person. Texts are cut: read_conversation with a message:<id> reads its whole conversation.",
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
          if (!visible(exchange, scope, privacy)) continue;
          const haystack = fold(`${exchange.payload.author ?? ""} ${exchange.payload.place ?? ""} ${exchange.payload.input ?? ""} ${exchange.payload.output ?? ""}`);
          if (person && !haystack.includes(person)) continue;
          if (!words.every((w) => haystack.includes(w))) continue;
          // message:<id>: read_conversation reads it whole, send answers there.
          found.push(`- ${exchange.payload.place ?? ""} [${exchange.thread_key}]: ${line(exchange, 300)}`);
        }
        return found.join("\n") || "Nothing found.";
      },
    },
  ];
}
