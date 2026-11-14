import type { z } from "zod";

/** Where a reply goes back. Opaque for the core: only its connector reads the fields. */
export type Address = {
  connector: string;
  /** Channel, e-mail address… */
  conversation: string;
  /** Slack DM: "main"; elsewhere the thread's root. */
  thread: string;
  /** The message that triggered it (reaction, anchoring, read up to here). */
  ts?: string;
};

/** The thread an address is in: without its message. The one thing the core does with an Address. */
export const threadOf = ({ ts: _, ...address }: Address): Address => address;

export type AuthorKind = "human" | "bot" | "system";

/** What a connector (or a source) hands to the core. The core never reads the payload. */
export type InboxRow = {
  /** UNIQUE: slack:C:ts, email:Message-ID, reminder:id:due_at… */
  source_id: string;
  address: Address;
  thread_key: string;
  /** The key of the place whose engagement mode applies (a channel). */
  mode_key: string;
  author_id: string;
  author_kind: AuthorKind;
  owner_only: boolean;
  private: boolean;
  /** A DM with the agent itself. */
  dm: boolean;
  mentions_agent: boolean;
  mentions_owner: boolean;
  /** ISO: the core compares dates, never connector ids. */
  sent_at: string;
  payload: unknown;
  /** The plain text: the owner's commands read it, and a system row's event is told with it. */
  text?: string;
  caught_up?: boolean;
};

export type Post =
  /** as "owner": posted in the owner's name (a draft he validated). */
  | { text: string; as?: "owner" }
  /** An emoji (its name, e.g. "thumbsup") on the message of the address (its ts). Only to a connector that reacts. */
  | { reaction: string };

export type DeliverResult =
  | { ok: true; ref: string; sent_at: string; link?: string }
  /** transient: the post certainly did not leave (429, 5xx received, connection refused). Ambiguous: throw. */
  | { ok: false; transient: boolean; error: string };

export type ThreadMessage = { author: string; text: string; at: string };
/** A message found by a connector's search: where it is, to read its conversation. */
export type Found = { at: string; author: string; place: string; text: string; address: Address };
export type Thread = { label: string; messages: ThreadMessage[] };

/** Who speaks, where: decided by code, never by the model. */
export type Scope = { owner: boolean; requester: string; private: boolean };

/**
 * What one conversation may recall of the others. on: what was said in private never comes up elsewhere, except to
 * the owner what the owner said. off: every conversation recalls everything (one trusted team).
 */
export type Privacy = { ownerId: string; on: boolean };

export const mayRecall = (item: { private: boolean; author: string }, scope: Scope, privacy: Privacy) =>
  !privacy.on || !item.private || (scope.owner && item.author === privacy.ownerId);

/** Now, as the agent reads it: the weekday, local time, the time zone. */
export function clock(at = new Date()): string {
  const day = at.toLocaleDateString("en-GB", { weekday: "long" });
  return `${day} ${localTime(at.toISOString())} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
}

/** A date as the agent reads it: local time (the process's TZ), to the minute. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The shape of a reply on a connector. */
export type Form = {
  schema(row: InboxRow, scope: Scope): z.ZodType;
  /** The prompts this form is guided by, by name, with their defaults (editable like the others). */
  prompts: Record<string, string>;
  /** Which of its prompts guides this reply, with the values its {{name}}s take. */
  guide(row: InboxRow, scope: Scope): { prompt: string; vars?: Record<string, string> };
  /** held: the posts wait for the owner; note: what he reads to decide (what it answers, why it waits). */
  toPosts(output: unknown): { posts: Post[]; held: boolean; note?: string };
};

export interface Connector {
  id: string;
  /** Starts listening; every raw event goes to the sink. */
  start(sink: (raw: unknown) => void): Promise<void>;
  stop?(): Promise<void>;
  /** Raw event → row, or null when it is not for the agent (not a member, its own message…). */
  toInbox(raw: unknown): Promise<InboxRow | null>;
  /** The thread up to this message, included, readable. */
  read(address: Address): Promise<Thread>;
  form: Form;
  deliver(address: Address, post: Post): Promise<DeliverResult>;
  typing?(address: Address): Promise<void>;
  /** Called on (re)connection: the core retries what was waiting and catches up after a real outage. */
  onConnected?(callback: () => void): void;
  /** Called on disconnection: the core freezes its catch-up cursor. */
  onDisconnected?(callback: () => void): void;
  /** Raw events since this date (ISO), for the catch-up after a restart or an outage. */
  catchUp?(since: string): AsyncIterable<unknown>;
  /** Search the whole place (not only where the agent is), with the owner's rights: the owner's tool only. */
  search?(query: string, limit: number): Promise<Found[]>;
  /** It delivers { reaction } posts: the triage gate may then react where the agent stays silent. */
  reacts?: boolean;
  /** A person (name or id) → the address of a direct message with them, or null. */
  resolve?(person: string): Promise<Address | null>;
  /** The thread_key its rows carry for this address. Default: connector:conversation:thread. */
  threadKeyOf?(address: Address): string;
}

/** How the agent engages in a place: only when mentioned, once mentioned in a thread, or triaged by a cheap model. */
export type Mode = "mention" | "mention-sticky" | "triage";

/** Who may use a tool: every conversation, or the owner's private one. Decided by code, never by the model. */
export type Rule = "all" | "owner";

/**
 * Where the tool is called from: the rights, the conversation, the lot being answered. sent: the sends of this run,
 * per place (the n-th send to a place in a lot has its own key, the same in a re-run).
 */
export type ToolContext = { scope: Scope; threadKey: string; lotIds: number[]; connector: string; address: Address; sent?: Map<string, number> };

export type ToolDef = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  rules: Rule[];
  /** It changes something beyond reading (posts, writes, starts): a draft for the owner never gets it. */
  effect?: boolean;
  run(args: Record<string, unknown>, context: ToolContext): Promise<string>;
};

/** A tool bound to one respond(): its context is fixed, the model only gives the arguments. */
export type BoundTool = { name: string; description: string; input: z.ZodRawShape; run(args: Record<string, unknown>): Promise<string> };

/** The model call: a prompt, a schema, a validated object back. Throws TransientError when worth retrying later. */
/** signal: aborted when the core stops waiting (its deadline); a brain should then stop its work too. */
/** onRun: what the call cost, told once it ends (success or not), for the trace. */
export type BrainRun = { turns: number; cost_usd: number; ms: number; outcome: string };
export type Brain = (request: { system: string; prompt: string; schema: z.ZodType; tools?: BoundTool[]; signal?: AbortSignal; onRun?: (run: BrainRun) => void }) => Promise<unknown>;

export class TransientError extends Error {}
