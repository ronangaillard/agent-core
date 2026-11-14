import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Core, defaultConfig, type CoreConfig, type CoreOptions } from "../src/core.ts";
import { openDb } from "../src/db.ts";
import type { Address, Brain, Connector, DeliverResult, InboxRow, Post, Scope, ThreadMessage } from "../src/types.ts";

export const config: CoreConfig = {
  ...defaultConfig,
  ownerId: "ronan",
  persona: "You are a test agent.",
  settleHumanMs: 20,
  settleBotMs: 20,
  settleMaxMs: 200,
  maxRuns: 3,
  backoffMs: [30, 60],
  maxRetryAgeMs: 60_000,
  deliverTimeoutMs: 200,
  ownerAddress: { connector: "fake", conversation: "owner", thread: "main" },
};

/** The outside world, shared by successive cores: what was said in each thread. */
export class World {
  readonly threads = new Map<string, ThreadMessage[]>();
  private next = 0;

  say(text: string, options: { thread?: string; author?: string; kind?: InboxRow["author_kind"]; dm?: boolean; mention?: boolean; mentionsOwner?: boolean; ownerOnly?: boolean } = {}): InboxRow {
    const thread = options.thread ?? "t1";
    const at = new Date(Date.now() + this.next).toISOString();
    const id = ++this.next;
    const list = this.threads.get(thread) ?? [];
    list.push({ author: options.author ?? "ronan", text, at });
    this.threads.set(thread, list);
    return {
      source_id: `fake:${id}`,
      address: { connector: "fake", conversation: thread, thread: "main", ts: String(id) },
      thread_key: `fake:${thread}`,
      mode_key: `fake:${thread}`,
      author_id: options.author ?? "ronan",
      author_kind: options.kind ?? "human",
      owner_only: options.ownerOnly ?? true,
      private: true,
      dm: options.dm ?? true,
      mentions_agent: options.mention ?? false,
      mentions_owner: options.mentionsOwner ?? false,
      sent_at: at,
      payload: { text },
      text,
    };
  }
}

/** A connector on the World; deliver can be swapped to simulate failures. */
export class FakeConnector implements Connector {
  id = "fake";
  sent: { address: Address; post: Post }[] = [];
  scopes: Scope[] = [];
  deliverImpl: ((address: Address, post: Post) => Promise<DeliverResult>) | undefined;
  /** What a catch-up returns, and the dates it was asked from. */
  missed: InboxRow[] = [];
  catchUps: string[] = [];
  private readonly connected: (() => void)[] = [];
  private readonly disconnected: (() => void)[] = [];

  constructor(private readonly world: World) {}

  /** The core's sink, to push live events; and how many catch-ups fail before one works. */
  sink: ((raw: unknown) => void) | undefined;
  failingCatchUps = 0;
  /** A catch-up that takes this long before yielding (a pass running while things happen). */
  catchUpDelayMs = 0;
  async start(sink: (raw: unknown) => void) {
    this.sink = sink;
  }
  onConnected(callback: () => void) {
    this.connected.push(callback);
  }
  onDisconnected(callback: () => void) {
    this.disconnected.push(callback);
  }
  drop() {
    this.disconnected.forEach((callback) => callback());
  }
  reconnect() {
    this.connected.forEach((callback) => callback());
  }
  async *catchUp(since: string) {
    this.catchUps.push(since);
    if (this.catchUpDelayMs) await new Promise((resolve) => setTimeout(resolve, this.catchUpDelayMs));
    if (this.failingCatchUps > 0) {
      this.failingCatchUps--;
      throw new Error("ratelimited");
    }
    for (const row of this.missed) if (row.sent_at >= since) yield row;
  }
  threadKeyOf(address: Address) {
    return `fake:${address.conversation}`;
  }
  async resolve(person: string): Promise<Address | null> {
    return person === "nobody" ? null : { connector: "fake", conversation: `dm-${person}`, thread: "main" };
  }
  async toInbox(raw: unknown) {
    return raw as InboxRow;
  }
  async read(address: Address) {
    return { label: "test", messages: [...(this.world.threads.get(address.conversation) ?? [])] };
  }
  /** Set: every reply waits for the owner, with this note. */
  holdWith: string | undefined;
  form = {
    schema: () => z.object({ messages: z.array(z.string()) }),
    prompts: { fake: "Answer." },
    guide: (_row: InboxRow, scope: Scope) => {
      this.scopes.push(scope);
      return { prompt: "fake" };
    },
    toPosts: (output: unknown) => ({
      posts: (output as { messages: string[] }).messages.map((text): Post => ({ text })),
      held: this.holdWith !== undefined,
      ...(this.holdWith ? { note: this.holdWith } : {}),
    }),
  };
  async deliver(address: Address, post: Post): Promise<DeliverResult> {
    if (this.deliverImpl) return this.deliverImpl(address, post);
    return this.post(address, post);
  }
  post(address: Address, post: Post): DeliverResult {
    this.sent.push({ address, post });
    const list = this.world.threads.get(address.conversation) ?? [];
    list.push({ author: "you", text: "text" in post ? post.text : "", at: new Date().toISOString() });
    this.world.threads.set(address.conversation, list);
    return { ok: true, ref: String(this.sent.length), sent_at: new Date().toISOString() };
  }
}

/** A brain that answers "reply n", and remembers the prompts. */
export function echoBrain() {
  const prompts: string[] = [];
  const brain: Brain = async ({ prompt }) => {
    prompts.push(prompt);
    return { messages: [`reply ${prompts.length}`] };
  };
  return { brain, prompts };
}

/** A brain that never answers: the process dies while it thinks. */
export const hangingBrain: Brain = () => new Promise(() => undefined);

export function freshDb() {
  return join(mkdtempSync(join(tmpdir(), "agent-core-")), "agent.db");
}

export function makeCore(path: string, connector: Connector, brain: Brain, overrides: Partial<CoreConfig> = {}, extra: Partial<Omit<CoreOptions, "db" | "connectors" | "brain" | "config">> = {}) {
  return new Core({ db: openDb(path), connectors: [connector], brain, config: { ...config, ...overrides }, ...extra });
}

/** Tests only: wait for a condition. */
export async function waitFor(condition: () => boolean, ms = 3000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error("condition never met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
