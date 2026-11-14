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
  caught_up?: boolean;
};

export type Post =
  | { text: string }
  | { gif: string }
  | { text: string; buttons: string[] }
  | { reaction: string }
  | { file: { name: string; path: string } };

export type DeliverResult =
  | { ok: true; ref: string; sent_at: string; link?: string }
  /** transient: the post certainly did not leave (429, 5xx received, connection refused). Ambiguous: throw. */
  | { ok: false; transient: boolean; error: string };

export type ThreadMessage = { author: string; text: string; at: string };
export type Thread = { label: string; messages: ThreadMessage[] };

/** Who speaks, where: decided by code, never by the model. */
export type Scope = { owner: boolean; requester: string; private: boolean };

/** The shape of a reply on a connector. */
export type Form = {
  schema(row: InboxRow, scope: Scope): z.ZodType;
  guide(row: InboxRow, scope: Scope): string;
  toPosts(output: unknown): { posts: Post[]; held: boolean };
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
  /** Called on (re)connection: the core retries what was waiting. */
  onConnected?(callback: () => void): void;
}

/** The model call: a prompt, a schema, a validated object back. Throws TransientError when worth retrying later. */
export type Brain = (request: { system: string; prompt: string; schema: z.ZodType }) => Promise<unknown>;

export class TransientError extends Error {}
