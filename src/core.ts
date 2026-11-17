import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { allows, bind } from "./access.ts";
import { actTools } from "./act.ts";
import { Prompts } from "./prompts.ts";
import { inProgress, taskTools, taskVisible, type TaskRunner } from "./tasks.ts";
import { digest } from "./history.ts";
import type { Memory } from "./memory.ts";
import { Store, type InboxRecord, type OutboxRecord, type ReminderRecord, type TaskRecord } from "./store.ts";
import { TransientError, type Address, type BoundTool, type Brain, type Button, type BrainRun, type Connector, type DeliverResult, type InboxRow, clock, localTime, mayRecall, threadOf, type Mode, type Privacy, type Post, type Rule, type Scope, type ThreadMessage, type ToolContext, type ToolDef, type ToolResult } from "./types.ts";

/** The images the model sees, and their size limit (the API's is 5 MB). */
const IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_MAX = 5_000_000;

/** How long before a lot a post of the agent may still be missing from the connector's read. */
const READ_LAG_MS = 60_000;
const brief = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};
/** A message as the models read it: its local time, who, what. */
const asRead = (m: ThreadMessage) => `${m.at ? `[${localTime(m.at)}] ` : ""}${m.author}: ${m.text}`;

const gateSchema = z.object({ speak: z.boolean().describe("true only if the agent has a real reason to speak") });
const gateReactSchema = gateSchema.extend({
  reaction: z.string().optional().describe("When not speaking, rarely: an emoji name (e.g. thumbsup) on the last message, like a colleague reading"),
});

export type CoreConfig = {
  /** The owner's id on the connectors (scope owner, mentions). */
  ownerId: string;
  /** The system prompt's first part: who the agent is. The default of the persona prompt (see Prompts). */
  persona: string;
  /** Settle: quiet time before answering, re-armed at each new message, capped. */
  settleHumanMs: number;
  settleBotMs: number;
  settleMaxMs: number;
  /** At most this many respond() at once. */
  maxRuns: number;
  /** Backoff steps for transient failures (inbox and outbox), then the last one repeats. */
  backoffMs: number[];
  /** Past this age, a transient failure becomes final. */
  maxRetryAgeMs: number;
  deliverTimeoutMs: number;
  /** A model call (respond, the triage gate) longer than this is aborted and retried later. */
  brainTimeoutMs: number;
  /** The owner's line (his DM): alerts, and what waits for him. None: alerts are only events. */
  ownerAddress?: Address;
  ownerName: string;
  /** A human mentions the owner where the agent would not speak: draft his reply, held for him, sent in his name. */
  draftForOwner: boolean;
  /** Connectors whose events act with the owner's rights: sources the owner configured (e.g. github). Never chat ones. */
  ownerSources: string[];
  /** Engagement mode per place (mode_key), and the default. */
  modes: Record<string, Mode>;
  defaultMode: Mode;
  /** At most this many bot or system messages in a row in a thread, within an hour, without a human. */
  botCap: number;
  /** A disconnection longer than this triggers a catch-up at reconnection. */
  catchUpAfterMs: number;
  /** The catch-up never goes further back than this. */
  catchUpMaxMs: number;
  /** A caught-up message older than this is ignored, unless it is a DM or a mention. */
  catchUpStaleMs: number;
  /** false: every conversation recalls everything said elsewhere, private or not (see Privacy). */
  privacy: boolean;
  /** Named places the send tool may post to, each with who may use it. */
  destinations: Record<string, { address: Address; rules: Rule[] }>;
  maxRemindersPerThread: number;
  /** The repositories code tasks may work on; the first is the default. */
  repos: string[];
  /** A task a restart cut is run again this many times at most. */
  maxTaskResumes: number;
};

export const defaultConfig: Omit<CoreConfig, "ownerId" | "persona"> = {
  settleHumanMs: 1000,
  settleBotMs: 8000,
  settleMaxMs: 30_000,
  maxRuns: 3,
  backoffMs: [60_000, 5 * 60_000, 30 * 60_000],
  maxRetryAgeMs: 6 * 3600_000,
  deliverTimeoutMs: 30_000,
  brainTimeoutMs: 10 * 60_000,
  modes: {},
  defaultMode: "mention",
  privacy: true,
  botCap: 20,
  catchUpAfterMs: 30_000,
  catchUpMaxMs: 24 * 3600_000,
  catchUpStaleMs: 3600_000,
  destinations: {},
  maxRemindersPerThread: 5,
  ownerName: "the owner",
  draftForOwner: false,
  ownerSources: [],
  repos: [],
  maxTaskResumes: 2,
};

/** An owner's command: matched on the text of a row in his private scope, answered without the model. */
export type Command = {
  pattern: RegExp;
  help: string;
  run(match: RegExpMatchArray, core: Core): Promise<string>;
  /** How this command applies to a lot waiting for the owner, shown with it (e.g. "send 12"). */
  hint?(batch: number): string;
  /** The same as a button, where the connector has buttons (e.g. "Send" → "send 12"). */
  button?(batch: number): Button;
};

/** Code on a schedule (a digest, a cleanup…): never seen by the tools, set again at each start. */
export type Job = { everyMinutes: number; run(core: Core): Promise<void> };

export type CoreOptions = {
  db: DatabaseSync;
  connectors: Connector[];
  brain: Brain;
  config: CoreConfig;
  /** The cheap model of the triage mode. */
  gate?: Brain;
  tools?: ToolDef[];
  memory?: Memory;
  jobs?: Record<string, Job>;
  commands?: Command[];
  /** Does the code tasks. None: no start_code_task tool. */
  runner?: TaskRunner;
  /** The texts the agent is prompted with, editable (default: the built-in ones, in memory). */
  prompts?: Prompts;
};

/** A plain semaphore: at most n respond() at once; settle and triage stay outside. */
class Slots {
  private used = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async take() {
    if (this.used >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.used++;
  }
  give() {
    this.used--;
    this.waiting.shift()?.();
  }
}

type Verdict = "kept" | "ignored" | "capped" | "draft";

const MAX_TIMER_MS = 2 ** 31 - 1;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The next occurrence after now: missed ones while the agent was down fire once, not once each. */
function nextOccurrence(due: string, everyMinutes: number): string {
  const step = everyMinutes * 60_000;
  let at = Date.parse(due) + step;
  if (at <= Date.now()) at += Math.ceil((Date.now() - at + 1) / step) * step;
  return new Date(at).toISOString();
}

class Timeout extends Error {}

/** A row whose verdict could not be reached (its thread unreadable, the gate down). */
class PickError extends Error {
  constructor(
    readonly row: InboxRecord,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout()), ms);
    timer.unref?.();
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error: unknown) => (clearTimeout(timer), reject(error)),
    );
  });

/**
 * The core: an inbound queue (pending messages → one respond() per thread) and an outbound queue (posts →
 * connectors). No polling: wake() after every write, one timer on the next due date, one pass at start.
 */
export class Core {
  readonly store: Store;
  private readonly connectors = new Map<string, Connector>();
  /** Threads with a respond() running. With the replies not yet delivered, that is the lock. */
  private readonly busy = new Set<string>();
  private readonly lots = new Map<string, number[]>();
  private readonly delivering = new Set<number>();
  private readonly slots: Slots;
  /** The triage gate is cheap, but bounded too: a busy channel does not start a model call per message at once. */
  private readonly gates: Slots;
  private readonly tools: ToolDef[];
  readonly prompts: Prompts;
  /** The gate's reactions on the messages it kept silent, until they are closed (in memory: a re-run asks again). */
  private readonly gateReactions = new Map<number, string>();
  /** The last failure of a pending message, for when it is given up (in memory: a restart only loses the reason). */
  private readonly lastErrors = new Map<number, string>();
  private timer: NodeJS.Timeout | undefined;
  /** The code tasks running or queued (one runs at a time), by task id. */
  private readonly runs = new Map<number, AbortController>();
  /** The step a running task is at (its session's task list item in progress), in memory: said only when asked. */
  private readonly taskSteps = new Map<number, string>();
  private taskQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** Tests: a simulated crash, after which nothing at all is written. */
  private killed = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Connectors owing a catch-up, and those running one. */
  private readonly catching = new Set<string>();
  private readonly catchingNow = new Set<string>();
  private readonly catchAgain = new Set<string>();
  private started = false;
  private scheduling = false;

  constructor(private readonly options: CoreOptions) {
    this.store = new Store(options.db);
    this.prompts = options.prompts ?? new Prompts();
    this.prompts.seed("persona", options.config.persona);
    for (const connector of options.connectors) for (const [name, text] of Object.entries(connector.form.prompts)) this.prompts.seed(name, text);
    this.slots = new Slots(options.config.maxRuns);
    this.gates = new Slots(options.config.maxRuns);
    for (const connector of options.connectors) this.connectors.set(connector.id, connector);
    const owner = options.config.ownerAddress;
    if (owner) this.store.alertTo = { address: owner, threadKey: this.threadKeyOf(owner) };
    this.tools = [...(options.tools ?? []), ...actTools(this), ...(options.runner && options.config.repos.length ? taskTools(this, options.config.repos) : [])];
  }

  private get config() {
    return this.options.config;
  }

  async start() {
    for (const [name, job] of Object.entries(this.options.jobs ?? {})) this.store.setJob(name, later(job.everyMinutes * 60_000), job.everyMinutes);
    for (const orphan of this.store.orphans()) this.lost(orphan, "unknown");
    for (const connector of this.connectors.values()) {
      let downSince: number | undefined;
      connector.onDisconnected?.(() => {
        downSince ??= Date.now();
      });
      connector.onConnected?.(() => {
        this.wake();
        if (downSince !== undefined && Date.now() - downSince > this.config.catchUpAfterMs) this.owe(connector);
        downSince = undefined;
      });
      await connector.start((raw) => void this.receive(connector, raw));
      // A catch-up is owed from the stored cursor; until it completes, live messages do not move the cursor.
      if (connector.catchUp && this.store.cursor(connector.id)) this.owe(connector);
    }
    this.started = true;
    this.resumeTasks();
    this.wake();
  }

  /** A catch-up is owed: run now, or once more after the pass running ends (it may have read past what was missed). */
  private owe(connector: Connector) {
    if (!connector.catchUp) return;
    // A new debt starts a new series of tries once the last one is over (passed, or given up after five): an old
    // outage's failures do not cut this one short. A series still retrying keeps its count.
    if (!this.catchingNow.has(connector.id)) this.store.catchUpReset(connector.id);
    this.catching.add(connector.id);
    if (this.catchingNow.has(connector.id)) this.catchAgain.add(connector.id);
    else void this.catchUp(connector);
  }

  /**
   * What was said while the agent was away, from the stored cursor, through the same ingestion (source_id absorbs the
   * overlap). The cursor moves only when a pass completes. A failed pass is tried again on the one timer, after a
   * backoff, five times at most (then an alert; the next start or reconnection tries again).
   */
  private async catchUp(connector: Connector): Promise<void> {
    if (!connector.catchUp || this.stopped || this.catchingNow.has(connector.id)) return;
    const cursor = this.store.cursor(connector.id);
    if (!cursor) {
      this.store.catchUpRetryCleared(connector.id);
      return void this.catching.delete(connector.id);
    }
    this.catchingNow.add(connector.id);
    this.store.catchUpRetryCleared(connector.id);
    this.catchAgain.delete(connector.id);
    const started = new Date().toISOString();
    const since = new Date(Math.max(Date.parse(cursor) - 60_000, Date.now() - this.config.catchUpMaxMs)).toISOString();
    let again = false;
    try {
      for await (const raw of connector.catchUp(since)) {
        if (this.stopped) return;
        let row: InboxRow | null;
        try {
          row = await connector.toInbox(raw);
        } catch (error) {
          // One unreadable event does not stop the pass; a passing failure does.
          if (error instanceof TransientError) throw error;
          console.error(`${connector.id}: event not read`, error);
          continue;
        }
        if (row) this.ingest({ ...row, caught_up: true }, connector.id);
      }
      if (this.stopped) return;
      again = this.catchAgain.has(connector.id);
      if (!again) {
        this.store.catchUpDone(connector.id, started);
        this.catching.delete(connector.id);
      }
    } catch (error) {
      if (this.stopped) return;
      const failures = this.store.catchUpFailures(connector.id);
      const last = failures + 1 >= 5;
      console.error(`${connector.id}: catch-up interrupted`, error);
      this.store.catchUpFailed(
        connector.id,
        last ? null : later(this.backoff(failures)),
        last ? `Catching up on ${connector.id} failed five times (${error instanceof Error ? error.message : String(error)}): tried again at the next start or reconnection.` : undefined,
      );
      this.wake();
    } finally {
      this.catchingNow.delete(connector.id);
    }
    if (again) void this.catchUp(connector);
  }

  /** The catch-ups whose retry is due: on the one timer, like everything else. */
  private wakeCatchUps() {
    for (const id of this.store.catchUpsDue()) {
      const connector = this.connectors.get(id);
      if (connector && this.catching.has(id) && !this.catchingNow.has(id)) void this.catchUp(connector);
      // Nobody catches up there any more: the retry goes, or the timer would fire on it again and again.
      else if (!connector || !this.catching.has(id)) this.store.catchUpRetryCleared(id);
    }
  }

  /** SIGTERM: nothing new is picked; the lots in flight get their attempt back (a redeploy is not a failure). */
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const ids of this.lots.values()) this.store.uncountAttempt(ids);
    // Tasks keep their status running: the next start runs them again.
    for (const abort of this.runs.values()) abort.abort();
    // A post in flight gets its outcome written: a delivered one must not come back as "maybe sent".
    await Promise.allSettled([...this.inFlight]);
    for (const connector of this.connectors.values()) await connector.stop?.();
  }

  /** Tests: the process dies here, nothing more is written. */
  kill() {
    this.stopped = true;
    this.killed = true;
    clearTimeout(this.timer);
    for (const abort of this.runs.values()) abort.abort();
  }

  private async receive(connector: Connector, raw: unknown) {
    if (this.stopped) return;
    try {
      const row = await connector.toInbox(raw);
      if (!row) return;
      this.ingest(row, connector.id);
      // Live and nothing owed: everything up to this message is in.
      if (!this.catching.has(connector.id)) this.store.setCursor(connector.id, row.sent_at);
    } catch (error) {
      console.error(`${connector.id}: event not read`, error);
      // Not read for a reason that passes: a catch-up owes it, and the cursor stops here.
      if (error instanceof TransientError) this.owe(connector);
    }
  }

  /** Durable first, then the signal. Also the entry of sources (scheduler, webhooks). */
  ingest(row: InboxRow, connector: string): number | null {
    const id = this.store.ingest(row, connector);
    if (id !== null) this.wake();
    return id;
  }

  /**
   * The one signal: after every write, at the timer, once at start. Always the three passes, then the timer on the
   * next future date: a partial pass that re-armed the timer could drop something that just became due.
   */
  wake() {
    // Not before every connector started: a pass would read with a connector not ready (its own id unknown).
    if (this.stopped || !this.started) return;
    this.wakeCatchUps();
    this.wakeScheduler();
    this.wakeInbound();
    this.wakeOutbound();
    this.arm();
  }

  /** The thread_key a connector's rows carry for this address. */
  threadKeyOf(address: Address): string {
    return this.connectors.get(address.connector)?.threadKeyOf?.(address) ?? `${address.connector}:${address.conversation}:${address.thread}`;
  }

  // --- scheduler -----------------------------------------------------------------------------------------------

  /** What is due: a reminder becomes a system row (the core answers it like a message), a job runs its code. */
  private wakeScheduler() {
    // A job that ingests calls wake() from inside this loop: the inner pass would fire what the outer one holds.
    if (this.stopped || this.scheduling) return;
    this.scheduling = true;
    try {
      this.schedule();
    } finally {
      this.scheduling = false;
    }
  }

  private schedule() {
    for (const due of this.store.dueReminders()) {
      const next = due.repeat_minutes ? nextOccurrence(due.due_at, due.repeat_minutes) : null;
      if (due.kind === "job") {
        const job = due.job ? this.options.jobs?.[due.job] : undefined;
        // Re-armed before it runs: a crash mid-run skips one run, never repeats it.
        if (!this.store.fire(due, job ? next : null, null)) continue;
        if (job) void job.run(this).catch((error: unknown) => this.alert(`Job ${due.job} failed: ${error instanceof Error ? error.message : String(error)}`));
        continue;
      }
      this.store.fire(due, next, this.reminderRow(due));
    }
  }

  private reminderRow(due: ReminderRecord): InboxRow | null {
    if (!due.address || !due.thread_key) return null;
    const address = threadOf(due.address);
    return {
      source_id: `reminder:${due.id}:${due.due_at}`,
      address,
      thread_key: due.thread_key,
      mode_key: due.thread_key,
      author_id: "scheduler",
      author_kind: "system",
      owner_only: false,
      private: due.private,
      dm: false,
      mentions_agent: false,
      mentions_owner: false,
      sent_at: new Date().toISOString(),
      payload: { reminder: due.id },
      text: `A reminder you set (asked by ${due.created_by ?? "?"}${due.repeat_minutes ? `, repeats every ${due.repeat_minutes} min` : ""}): ${due.note}`,
    };
  }

  /** Called by the reminder tools. */
  remind(context: ToolContext, at: string, everyMinutes: number | null, note: string): string {
    const count = this.store.reminders(context.threadKey).length;
    if (count >= this.config.maxRemindersPerThread) return `Already ${count} reminders in this conversation: cancel one first.`;
    const id = this.store.addReminder({
      due_at: at,
      repeat_minutes: everyMinutes,
      note,
      connector: context.connector,
      address: context.address,
      thread_key: context.threadKey,
      created_by: context.scope.requester,
      private: context.scope.private,
    });
    this.arm();
    return `Reminder #${id} set for ${at}.`;
  }

  // --- acting elsewhere ----------------------------------------------------------------------------------------

  get privacy(): Privacy {
    return { ownerId: this.config.ownerId, on: this.config.privacy };
  }

  /** What search_messages found, by ref (found:<n>), for read_conversation: the last 500, in memory. */
  private readonly found = new Map<number, { connector: string; address: Address }>();
  private foundNext = 1;

  searchable(): boolean {
    return [...this.connectors.values()].some((c) => c.search);
  }

  /** The search_messages tool: every connector that can search, with the owner's rights. The owner's alone, unless privacy is off. */
  async searchMessages(context: ToolContext, query: string, limit: number): Promise<string> {
    if (!context.scope.owner && this.config.privacy) return "Not allowed here.";
    const lines: string[] = [];
    for (const connector of this.connectors.values()) {
      if (!connector.search) continue;
      for (const hit of await connector.search(query, limit)) {
        const ref = this.foundNext++;
        this.found.set(ref, { connector: connector.id, address: hit.address });
        if (this.found.size > 500) this.found.delete(this.found.keys().next().value!);
        const text = hit.text.replace(/\s+/g, " ");
        lines.push(`- ${localTime(hit.at)} found:${ref} ${hit.place} ${hit.author}: "${text.length > 500 ? `${text.slice(0, 500)}…` : text}"`);
      }
    }
    return lines.join("\n") || "Nothing found.";
  }

  /** The read_conversation tool: the whole conversation of a message, under the same rule as the digest. */
  async readConversation(context: ToolContext, ref: string): Promise<string> {
    const hit = /^found:(\d+)$/.exec(ref.trim());
    if (hit) {
      const found = context.scope.owner || !this.config.privacy ? this.found.get(Number(hit[1])) : undefined;
      const connector = found && this.connectors.get(found.connector);
      if (!found || !connector) return "No such message (found:<n> refs last until a restart).";
      const thread = await connector.read(found.address);
      return `${thread.label}\n${thread.messages.map(asRead).join("\n")}`;
    }
    const id = /^(?:message:)?(\d+)$/.exec(ref.trim());
    const row = id ? this.store.inbox(Number(id[1])) : undefined;
    if (!row || !mayRecall({ private: row.private, author: row.author_id }, context.scope, this.privacy)) return "No such message.";
    const connector = this.connectors.get(row.connector);
    if (!connector) return "No such message.";
    if (row.thread_key === context.threadKey) return "That is this conversation: you already have it.";
    // The thread as it is now, not as it was at that message.
    const thread = await connector.read(threadOf(row.address));
    const lines = thread.messages.map(asRead);
    return `${thread.label} [${row.thread_key}]\n${lines.join("\n")}`;
  }

  /** Some connector can fetch shared files: the open_file tool exists. */
  opensFiles(): boolean {
    return [...this.connectors.values()].some((c) => c.file);
  }

  /** The open_file tool: an image is shown to the model, a text file read; the conversation's connector first. */
  async openFile(context: ToolContext, ref: string): Promise<ToolResult> {
    const id = ref.trim().replace(/^file:/, "");
    const here = this.connectors.get(context.connector);
    const connector = here?.file ? here : [...this.connectors.values()].find((c) => c.file);
    if (!connector?.file || !id) return "No such file.";
    const file = await connector.file(id);
    if (IMAGE.has(file.mime)) {
      if (file.data.length > IMAGE_MAX) return `${file.name}: too large to look at (${Math.round(file.data.length / 1e6)} MB).`;
      return { text: `${file.name} (${file.mime})`, image: { data: file.data.toString("base64"), mime: file.mime } };
    }
    const text = file.data.toString("utf8");
    if (!/^text\/|json|xml|yaml|csv|javascript|typescript|x-sh/.test(file.mime) && text.includes("\uFFFD")) return `${file.name}: a ${file.mime} file, it cannot be opened.`;
    return `${file.name} (${file.mime})\n${text.length > 30_000 ? `${text.slice(0, 30_000)}\n…(cut)` : text}`;
  }

  destinationNames(): string[] {
    return Object.keys(this.config.destinations);
  }

  /** A named destination, or for the owner: a person (direct message) or the thread of a message (message:<id>). */
  private async target(context: ToolContext, to: string): Promise<{ connector: Connector; address: Address } | string> {
    const named = this.config.destinations[to];
    if (named) {
      if (!allows(named.rules, context.scope)) return `${to}: not allowed here.`;
      const connector = this.connectors.get(named.address.connector);
      return connector ? { connector, address: named.address } : `${to}: no connector.`;
    }
    const known = this.destinationNames();
    if (!context.scope.owner) return `Unknown destination.${known.length ? ` Known: ${known.join(", ")}.` : ""}`;
    const message = /^message:(\d+)$/.exec(to);
    if (message) {
      const row = this.store.inbox(Number(message[1]));
      // The same rule as the digest.
      if (!row || !mayRecall({ private: row.private, author: row.author_id }, context.scope, this.privacy)) return "No such message.";
      const connector = this.connectors.get(row.connector);
      const address = threadOf(row.address);
      return connector ? { connector, address } : "No such message.";
    }
    // A person: found by this conversation's connector, else by the first that knows people (from GitHub, Slack).
    const here = this.connectors.get(context.connector);
    const connector = here?.resolve ? here : [...this.connectors.values()].find((c) => c.resolve);
    const address = await connector?.resolve?.(to);
    return connector && address ? { connector, address } : `Nobody named ${to}.`;
  }

  /**
   * The send tool. The key and the acted event are written before the call, in one transaction: a re-run sees what
   * was done, the same send never leaves twice. An ambiguous failure is never retried.
   */
  async send(context: ToolContext, to: string, text: string): Promise<string> {
    const target = await this.target(context, to);
    if (typeof target === "string") return target;
    const threadKey = this.threadKeyOf(target.address);
    if (threadKey === context.threadKey) return "That is this conversation: put it in your reply instead.";
    // The n-th send to this place in this run: a re-run of the lot, reworded or not, finds the same keys.
    const sent = context.sent ?? new Map<string, number>();
    const nth = (sent.get(threadKey) ?? 0) + 1;
    sent.set(threadKey, nth);
    const post = { text };
    const id = this.store.startSend({
      // One send per place per lot: a re-run that rewords it does not send it twice.
      idem_key: `${context.threadKey}:${context.lotIds[0] ?? 0}:${hash(threadKey)}:${nth}`,
      thread_key: context.threadKey,
      target_thread: threadKey,
      connector: target.connector.id,
      address: target.address,
      post,
      private: context.scope.private,
      summary: `sent to ${to}: "${text.length > 120 ? `${text.slice(0, 120)}…` : text}"`,
    });
    if (id === null) return "Already sent there for these messages: not sent again.";
    const row = this.store.outbox(id)!;
    let result: DeliverResult;
    try {
      // Awaited by a SIGTERM like any delivery: its outcome is written.
      const delivery = withTimeout(target.connector.deliver(target.address, post), this.config.deliverTimeoutMs);
      const tracked = delivery.catch(() => undefined);
      this.inFlight.add(tracked);
      void tracked.finally(() => this.inFlight.delete(tracked));
      result = await delivery;
    } catch (error) {
      if (this.killed) return "Stopped.";
      this.store.dead(row, error instanceof Timeout ? "timeout" : "unknown");
      return "Status unknown: it may have been sent. Do not send it again.";
    }
    if (result.ok) {
      this.store.delivered(row, result.ref, result.sent_at);
      return `Sent${result.link ? `: ${result.link}` : "."}`;
    }
    this.store.dead(row, result.error);
    this.store.freeKey(id);
    return `Not sent: ${result.error}.`;
  }

  // --- code tasks ----------------------------------------------------------------------------------------------

  /**
   * The start_code_task tool. Which task: the one named (if visible from here), else the only one open in this
   * conversation, else a new one. A running task is changed only by its requester or the owner; the rights of the
   * continuation are the lesser of the task's and the requester's.
   */
  async startTask(context: ToolContext, ask: { request: string; title?: string; task?: number; fresh: boolean; repo?: string }): Promise<string> {
    const { scope } = context;
    // Its own conversation always sees a task; elsewhere, the privacy rule of the digest.
    const visible = (task: TaskRecord) => task.thread_key === context.threadKey || taskVisible(task, scope, this.privacy);
    const known = () => {
      const list = this.store.recentTasks(new Date(Date.now() - 30 * 24 * 3600_000).toISOString()).filter(visible);
      return list.length ? ` Tasks you can continue: ${list.map((t) => `#${t.id} "${t.title}"`).join(", ")}.` : "";
    };
    let task: TaskRecord | undefined;
    if (ask.task !== undefined) {
      task = this.store.task(ask.task);
      if (!task || task.status === "abandoned" || !visible(task)) return `No task #${ask.task} to continue.${known()}`;
    } else if (!ask.fresh) {
      const open = this.store.openTasks(context.threadKey).filter(visible);
      if (open.length > 1) return `Several tasks are open here: ${open.map((t) => `#${t.id} "${t.title}"`).join(", ")}. Say which one (task).`;
      task = open[0];
    }
    const from = threadOf(context.address);
    if (!task) {
      // With several repositories, which one is never guessed.
      if (!ask.repo && this.config.repos.length > 1) return `Which repository? Give repo, one of: ${this.config.repos.join(", ")}. Nothing was started.`;
      const repo = ask.repo ?? this.config.repos[0];
      if (!repo || !this.config.repos.includes(repo)) return `Not a repository you work on. Allowed: ${this.config.repos.join(", ")}.`;
      const created = this.store.createTask({
        connector: context.connector,
        address: from,
        thread_key: context.threadKey,
        title: ask.title ?? ask.request.slice(0, 60),
        repo,
        request: ask.request,
        requester: scope.requester,
        owner_asked: scope.owner,
        private: scope.private,
      });
      this.launch(created, ask.request, false, from);
      return `Task #${created.id} started on ${repo} (branch ${created.branch}). Say in one sentence that you are on it; the report will come in this conversation.`;
    }
    // Changed by its requester, the owner, or in its own conversation; not taken over from elsewhere.
    if (!scope.owner && scope.requester !== task.requester && task.thread_key !== context.threadKey) {
      return `Task #${task.id} was asked by someone else: only they, the owner, or its own conversation can change it.`;
    }
    this.runs.get(task.id)?.abort();
    this.store.updateTask(task.id, { status: "running", request: ask.request, owner_asked: task.owner_asked && scope.owner, resumes: 0 });
    // A private conversation is not handed to a task that reports somewhere else: the request alone goes.
    const share = task.thread_key === context.threadKey || !scope.private;
    this.launch(this.store.task(task.id)!, ask.request, false, share ? from : undefined);
    const where = task.thread_key === context.threadKey ? "this conversation" : `its conversation (${task.thread_key})`;
    return `Task #${task.id} continues on its copy and branch${task.pr ? ` (PR #${task.pr})` : ""}. The report will come in ${where}.`;
  }

  /**
   * The abandon_code_task tool: the task named (if visible from here), else the only one open in this conversation.
   * Same rights as changing it. Its run is cut (the runner closes what it opened); the copy and branch stay.
   */
  async abandonTask(context: ToolContext, ask: { task?: number }): Promise<string> {
    const { scope } = context;
    const visible = (task: TaskRecord) => task.thread_key === context.threadKey || taskVisible(task, scope, this.privacy);
    let task: TaskRecord | undefined;
    if (ask.task !== undefined) {
      task = this.store.task(ask.task);
      if (!task || !visible(task)) return `No task #${ask.task}.`;
    } else {
      const open = this.store.openTasks(context.threadKey).filter(visible);
      if (open.length > 1) return `Several tasks are open here: ${open.map((t) => `#${t.id} "${t.title}"`).join(", ")}. Say which one (task).`;
      task = open[0];
      if (!task) return "No open task here: say which one (task).";
    }
    if (task.status === "abandoned") return `Task #${task.id} is already abandoned.`;
    if (!scope.owner && scope.requester !== task.requester && task.thread_key !== context.threadKey) {
      return `Task #${task.id} was asked by someone else: only they, the owner, or its own conversation can abandon it.`;
    }
    this.runs.get(task.id)?.abort();
    this.runs.delete(task.id);
    this.store.updateTask(task.id, { status: "abandoned" }, `Task #${task.id} abandoned.`);
    this.forget(task.id);
    return `Task #${task.id} abandoned${task.pr ? ` (PR #${task.pr} stays open on GitHub)` : ""}.`;
  }

  /** Tasks a restart cut: run again, at most maxTaskResumes times, then failed with a word in their conversation. */
  private resumeTasks() {
    if (!this.options.runner) return;
    for (const task of this.store.tasksWith("running")) {
      if (task.resumes >= this.config.maxTaskResumes) {
        this.store.updateTask(task.id, { status: "failed" }, `Task #${task.id} blocked: cut by restarts too many times. Ask again to resume it.`);
        continue;
      }
      this.store.updateTask(task.id, { resumes: task.resumes + 1 });
      this.launch(this.store.task(task.id)!, task.request, true, task.address);
    }
  }

  /**
   * A task's pull request closed: merged, the task is done; closed unmerged, abandoned. Nothing is posted (whoever
   * merged knows); asking again still continues it. A running task is left to its run.
   */
  pullRequestClosed(repo: string, pr: number, merged: boolean) {
    for (const task of this.store.tasksOfPr(repo, pr)) {
      this.store.updateTask(task.id, { status: merged ? "done" : "abandoned" });
      this.forget(task.id);
    }
  }

  /** A task over for good: what the runner keeps for it goes, after any run of it (tasks run one at a time, queued). */
  private forget(taskId: number) {
    const runner = this.options.runner;
    if (!runner?.forget) return;
    this.taskQueue = this.taskQueue
      .then(() => runner.forget!(taskId))
      .catch((error: unknown) => console.error(`task #${taskId}: its copy not removed`, error));
  }

  /** One task runs at a time; a replaced or stopped run writes nothing more. */
  private launch(task: TaskRecord, request: string, resumed: boolean, from: Address | undefined) {
    const runner = this.options.runner;
    if (!runner) return;
    const abort = new AbortController();
    this.runs.set(task.id, abort);
    const over = () => abort.signal.aborted || this.stopped;
    const run = this.taskQueue.then(async () => {
      if (over()) return;
      try {
        const thread = from ? await this.connectors.get(from.connector)?.read(from).catch(() => undefined) : undefined;
        const outcome = await runner({
          task,
          request,
          conversation: thread ? thread.messages.map(asRead).join("\n") : "",
          resumed,
          signal: abort.signal,
          // Nothing is posted along the way (only the end is): the step is kept for whoever asks where it stands.
          progress: (text) => {
            if (!over()) this.taskSteps.set(task.id, text);
          },
          setPr: (pr) => this.store.updateTask(task.id, { pr }),
        });
        if (over()) return;
        this.store.updateTask(task.id, { status: outcome.status }, outcome.report);
        if (outcome.status === "done") this.forget(task.id);
      } catch (error) {
        if (over()) return;
        const message = error instanceof Error ? error.message : String(error);
        // Not done: it stays open, and asking again resumes it on its copy and branch.
        this.store.updateTask(task.id, { status: "failed" }, `Task #${task.id} failed: ${message}. Ask again to resume it.`, `Code task #${task.id} failed: ${message}`);
      } finally {
        if (this.runs.get(task.id) === abort) {
          this.runs.delete(task.id);
          this.taskSteps.delete(task.id);
        }
        if (!this.stopped) this.wake();
      }
    });
    this.taskQueue = run.catch(() => undefined);
  }

  // --- inbound -------------------------------------------------------------------------------------------------

  private wakeInbound() {
    if (this.stopped) return;
    for (const thread of this.store.eligibleThreads()) {
      if (this.busy.has(thread) || this.store.hasReplyInFlight(thread)) continue;
      // Taken before any await: two passes never pick the same thread.
      this.busy.add(thread);
      void this.handle(thread);
    }
  }

  /** What the core decides with the row's facts, never its payload: catch-up, engagement mode, bot cap. */
  private async verdict(row: InboxRecord): Promise<Verdict> {
    if (row.caught_up) {
      const seen = this.store.lastDeliveredAt(row.thread_key);
      if (seen && row.sent_at < seen) return "ignored";
      // Chatter heard too late is let go; an event (a deployment, a run) is not: it still asks for something.
      if (Date.now() - Date.parse(row.sent_at) > this.config.catchUpStaleMs && !row.dm && !row.mentions_agent && row.author_kind !== "system") return "ignored";
    }
    const kept = await this.engaged(row);
    if (!kept) return this.config.draftForOwner && row.mentions_owner && row.author_kind === "human" && row.author_id !== this.config.ownerId ? "draft" : "ignored";
    if (row.author_kind !== "human") {
      const since = new Date(Date.now() - 3600_000).toISOString();
      if (this.store.nonHumanStreak(row.thread_key, row.id, since) > this.config.botCap) return "capped";
    }
    return "kept";
  }

  private async engaged(row: InboxRecord): Promise<boolean> {
    if (row.author_kind === "system" || row.dm || row.mentions_agent) return true;
    const mode = this.config.modes[row.mode_key] ?? this.config.defaultMode;
    if (mode === "mention") return false;
    if (mode === "mention-sticky") return this.store.agentSpokeIn(row.thread_key);
    return this.triage(row);
  }

  /** The cheap model decides whether the agent chimes in. No gate configured: silence. */
  private async triage(row: InboxRecord): Promise<boolean> {
    const gate = this.options.gate;
    const connector = this.connectors.get(row.connector);
    if (!gate || !connector) return false;
    await this.gates.take();
    try {
      return await this.ask(gate, connector, row);
    } finally {
      this.gates.give();
    }
  }

  /**
   * A model call with a deadline: past it, the call is aborted (the brain stops its work) and it is a passing failure,
   * retried later. A call that never answers would otherwise hold its thread's lock and its slot for good.
   */
  private async think(brain: Brain, request: Parameters<Brain>[0], trace: { model: string; row: InboxRecord }): Promise<unknown> {
    const abort = new AbortController();
    const onRun = (run: BrainRun) => this.store.trace("run", trace.row.thread_key, trace.row.private, trace.row.id, { model: trace.model, ...run });
    this.store.activity.emit("event", { kind: "thinking", thread_key: trace.row.thread_key, ref: trace.row.id, payload: { model: trace.model } });
    try {
      return await withTimeout(brain({ ...request, signal: abort.signal, onRun }), this.config.brainTimeoutMs);
    } catch (error) {
      if (!(error instanceof Timeout)) throw error;
      abort.abort();
      throw new TransientError(`the model did not answer within ${Math.round(this.config.brainTimeoutMs / 1000)} s`);
    }
  }

  private async ask(gate: Brain, connector: Connector, row: InboxRecord): Promise<boolean> {
    const thread = await connector.read(row.address);
    // The message asked about, marked: later ones may follow it (a lot, a read that goes on).
    const asked = thread.messages.find((m) => m.at === row.sent_at) ?? thread.messages.at(-1);
    const transcript = thread.messages.slice(-15).map((m) => `${m === asked ? "[new] " : ""}${asRead(m)}`).join("\n");
    // A connector that cannot react is never offered to.
    const schema = connector.reacts ? gateReactSchema : gateSchema;
    const output = schema.parse(
      await this.think(gate, {
        system: [this.prompts.text("gate", { label: thread.label }), connector.reacts ? this.prompts.text("gate-react") : "", this.prompts.text("persona")].filter(Boolean).join("\n\n"),
        prompt: `<conversation>\n${transcript}\n</conversation>\n\nShould the agent answer the message marked [new]?`,
        schema,
      }, { model: "gate", row }),
    ) as { speak: boolean; reaction?: string };
    if (!output.speak && output.reaction?.trim()) this.gateReactions.set(row.id, output.reaction.trim());
    return output.speak;
  }

  /** From the head: what can be answered now. A system row goes alone; a failed, ignored or capped row is closed here. */
  private async pick(thread: string, verdicts: Map<number, Verdict>): Promise<InboxRecord[]> {
    const lot: InboxRecord[] = [];
    const due = new Date().toISOString();
    for (const row of this.store.pending(thread)) {
      if (row.next_attempt_at && row.next_attempt_at > due) break;
      if (await this.command(row)) continue;
      if (row.attempts >= 2) {
        const error = this.lastErrors.get(row.id);
        this.lastErrors.delete(row.id);
        // Who asked the agent directly hears it could not answer; a message it was not asked stays silent.
        const asked = row.author_kind === "human" && (row.dm || row.mentions_agent);
        this.store.fail(row, "attempts", `Message given up after two attempts (${row.source_id})${error ? `: ${error}` : "."}`, {
          ...(error ? { error } : {}),
          ...(asked ? { apology: this.prompts.text("failed-reply", { owner: this.config.ownerName }) } : {}),
        });
        queueMicrotask(() => this.wake());
        continue;
      }
      let verdict = verdicts.get(row.id);
      if (!verdict) {
        try {
          verdict = await this.verdict(row);
        } catch (error) {
          throw new PickError(row, error);
        }
        verdicts.set(row.id, verdict);
      }
      if (verdict === "ignored") {
        const reaction = this.gateReactions.get(row.id);
        this.gateReactions.delete(row.id);
        this.store.close(row, "ignored", reaction ? { reaction } : undefined, reaction);
        if (reaction) queueMicrotask(() => this.wake());
        continue;
      }
      if (verdict === "capped") {
        const announce = !this.store.cappedSinceHuman(row.thread_key);
        this.store.cap(row, announce);
        if (announce) queueMicrotask(() => this.wake());
        continue;
      }
      // A system row or a draft for the owner goes alone.
      if (row.author_kind === "system" || verdict === "draft") {
        if (lot.length === 0) lot.push(row);
        break;
      }
      lot.push(row);
    }
    return lot;
  }

  /** Waits for the thread to go quiet, re-armed at each new message, capped; then the lot is fixed. */
  private async settle(thread: string, lot: InboxRecord[], verdicts: Map<number, Verdict>): Promise<InboxRecord[]> {
    if (lot[0]?.author_kind === "system") return lot;
    const started = Date.now();
    for (;;) {
      const quiet = lot.some((row) => row.author_kind === "bot") ? this.config.settleBotMs : this.config.settleHumanMs;
      const wait = Math.min(quiet, this.config.settleMaxMs - (Date.now() - started));
      if (wait <= 0) return lot;
      await sleep(wait);
      if (this.stopped) return [];
      const again = await this.pick(thread, verdicts);
      if (again.length === lot.length) return again;
      lot = again;
      if (lot.length === 0) return lot;
    }
  }

  private async handle(thread: string) {
    let ids: number[] = [];
    let slot = false;
    try {
      const verdicts = new Map<number, Verdict>();
      let lot = await this.settle(thread, await this.pick(thread, verdicts), verdicts);
      if (lot.length === 0 || this.stopped) return;
      await this.slots.take();
      slot = true;
      if (this.stopped) return;
      // New messages may have come while waiting for a slot: the lot is fixed now.
      lot = await this.pick(thread, verdicts);
      if (lot.length === 0) return;
      ids = lot.map((row) => row.id);
      this.store.countAttempt(ids);
      this.lots.set(thread, ids);
      await this.respond(lot, verdicts.get(lot[0]!.id) === "draft");
    } catch (error) {
      if (this.stopped) return;
      if (ids.length === 0) {
        // Failed before a lot was fixed (reading the thread, the gate): the row that failed waits, never spins; the
        // rows before it are not charged.
        if (error instanceof PickError) this.failed([error.row.id], error.row, error.cause, false);
        else {
          const head = this.store.pending(thread)[0];
          if (head) this.failed([head.id], head, error, false);
        }
        return;
      }
      const head = this.store.inbox(ids[0]!);
      if (head) this.failed(ids, head, error, true);
    } finally {
      if (slot) this.slots.give();
      this.lots.delete(thread);
      this.busy.delete(thread);
      if (!this.stopped) {
        this.wake();
      }
    }
  }

  /**
   * A transient failure waits without counting (6 h at most); any other counts, and waits a backoff before the next
   * try. counted: the attempt was already counted (a lot was fixed); before that, nothing was.
   */
  private failed(ids: number[], head: InboxRecord, error: unknown, counted: boolean) {
    if (error instanceof TransientError) {
      if (Date.now() - Date.parse(head.received_at) > this.config.maxRetryAgeMs) {
        const alert = `No reply possible for ${Math.round(this.config.maxRetryAgeMs / 3600_000)} h (${head.source_id}).`;
        ids.forEach((id, i) => {
          const row = this.store.inbox(id);
          if (row?.status === "pending") this.store.fail(row, "late", i === 0 ? alert : undefined);
        });
      } else {
        this.store.defer(ids, later(this.backoff(head.retries)), counted);
      }
      return;
    }
    console.error(`${head.thread_key}: failed`, error);
    // Kept for the give-up: the owner's alert and the failed event say why.
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    for (const id of ids) this.lastErrors.set(id, message);
    this.store.trace("error", head.thread_key, head.private, head.id, { error: message });
    if (!counted) this.store.countAttempt(ids);
    this.store.delay(ids, later(this.backoff(head.retries)));
  }

  /** A tool whose every call is an event: what it was asked, what it answered, how long (the owner sees what was tried). */
  private traced(tool: BoundTool, row: InboxRecord): BoundTool {
    const cut = (text: string) => (text.length > 600 ? `${text.slice(0, 600)}…` : text);
    return {
      ...tool,
      run: async (args) => {
        const started = Date.now();
        this.store.activity.emit("event", { kind: "tool_start", thread_key: row.thread_key, ref: row.id, payload: { tool: tool.name } });
        const record = (result: string, ok: boolean) =>
          this.store.trace("tool", row.thread_key, row.private, row.id, { tool: tool.name, args: cut(JSON.stringify(args)), result: cut(result), ok, ms: Date.now() - started });
        try {
          const result = await tool.run(args);
          const text = typeof result === "string" ? result : `${result.text} [image ${result.image.mime}]`;
          record(text, true);
          // An effect that happened is told to the next runs of this conversation: never done twice.
          if (tool.effect && !tool.recorded) this.store.act(row.thread_key, row.private, row.id, tool.name, `${tool.name} ${brief(JSON.stringify(args), 200)} → ${brief(text, 120)}`);
          return result;
        } catch (error) {
          record(error instanceof Error ? error.message : String(error), false);
          throw error;
        }
      },
    };
  }

  private isOwner(row: InboxRecord) {
    return row.author_kind === "human" && row.owner_only && row.author_id === this.config.ownerId;
  }

  /** The owner's commands, before anything else: answered by code, the row closed as intercepted. */
  private async command(row: InboxRecord): Promise<boolean> {
    const text = row.text?.trim();
    if (!text || !this.isOwner(row)) return false;
    for (const command of this.options.commands ?? []) {
      const match = text.match(command.pattern);
      if (!match) continue;
      const answer = await command.run(match, this).catch((error: unknown) => `Failed: ${error instanceof Error ? error.message : String(error)}`);
      this.store.intercept(row, answer);
      queueMicrotask(() => this.wake());
      return true;
    }
    return false;
  }

  /** Called by the owner's commands. */
  release(batch: number, text?: string): boolean {
    const released = this.store.release(batch, text);
    if (released) queueMicrotask(() => this.wake());
    return released;
  }

  drop(batch: number): boolean {
    return this.store.discard(batch);
  }

  /** The rights come from the rows, never from the model: the most restricted of the lot. */
  private scopeOf(lot: InboxRecord[]): Scope {
    const last = lot[lot.length - 1]!;
    return {
      // The owner, or the events of a connector the owner configured to act for him (ownerSources): his rights.
      owner: lot.every(
        (row) =>
          (row.author_kind === "human" && row.owner_only && row.author_id === this.config.ownerId) ||
          (row.author_kind === "system" && this.config.ownerSources.includes(row.connector)),
      ),
      requester: last.author_id,
      private: lot.some((row) => row.private),
    };
  }

  private async respond(lot: InboxRecord[], draft = false) {
    const last = lot[lot.length - 1]!;
    const connector = this.connectors.get(last.connector);
    if (!connector) throw new Error(`unknown connector: ${last.connector}`);
    const scope = this.scopeOf(lot);
    void connector.typing?.(last.address).catch(() => undefined);
    const thread = await connector.read(last.address);
    const said = (row: InboxRecord) => thread.messages.find((m) => m.at === row.sent_at);
    // The lot's messages, found by their date; a connector whose dates do not match: the last ones, as many.
    const found = new Set(lot.map(said).filter(Boolean));
    const system = last.author_kind === "system";
    const fresh = found.size || system ? found : new Set(thread.messages.slice(-lot.length));
    const transcript = thread.messages.map((m) => `${fresh.has(m) ? "[new] " : ""}${asRead(m)}`).join("\n");
    const late = lot.some((row) => row.caught_up) ? `\n${this.prompts.text("ask-late")}` : "";
    const elsewhere = digest(this.store, last.thread_key, scope, this.privacy);
    // Its own posts since the lot began (and just before): the read may lag, or stop before them.
    const since = new Date(Math.min(...lot.map((row) => Date.parse(row.sent_at))) - READ_LAG_MS).toISOString();
    // Those the read already shows are left out: said once is enough.
    const shown = (text: string) => thread.messages.some((m) => brief(m.text, 80) === brief(text, 80));
    const acted = [...this.store.acted(last.thread_key), ...this.store.posted(last.thread_key, since).filter((text) => !shown(text)).map((text) => `posted here: «${brief(text, 300)}»`)];
    const going = inProgress(this.store, scope, this.privacy, last.thread_key, this.taskSteps);
    const ask = system
      ? this.prompts.text("ask-event", { event: last.text ?? "" })
      : draft
        ? this.prompts.text("ask-draft", { owner: this.config.ownerName })
        : `${this.prompts.text("ask-new", { count: fresh.size })}${late}`;
    const prompt = [
      `Now: ${clock()}.`,
      elsewhere ? `Your other recent conversations (not this one), newest first:\n<elsewhere>\n${elsewhere}\n</elsewhere>` : "",
      `The conversation (${thread.label}), oldest first:\n<conversation>\n${transcript}\n</conversation>`,
      going ? `What you have going on, newest first:\n<in_progress>\n${going}\n</in_progress>` : "",
      acted.length ? `You already did, from this conversation (do not do it again):\n${acted.map((line) => `- ${line}`).join("\n")}` : "",
      ask,
    ]
      .filter(Boolean)
      .join("\n\n");
    const memory = this.options.memory?.index(scope) ?? "";
    const guide = connector.form.guide(last, scope);
    const instructions = [
      this.prompts.text("persona"),
      this.prompts.text(guide.prompt, guide.vars),
      this.prompts.text("tools-first"),
      memory ? `Your memory:\n<memory>\n${memory}\n</memory>` : "",
      this.prompts.text("safety"),
    ]
      .filter(Boolean)
      .join("\n\n");
    const schema = connector.form.schema(last, scope);
    // A draft acts on nothing: the owner has not approved anything yet.
    const bound = bind(draft ? this.tools.filter((tool) => !tool.effect) : this.tools, { scope, threadKey: last.thread_key, lotIds: lot.map((row) => row.id), connector: last.connector, address: last.address, sent: new Map(), read: new Set() });
    const tools = bound.map((tool) => this.traced(tool, last));
    const output = schema.parse(await this.think(this.options.brain, { system: instructions, prompt, schema, tools }, { model: draft ? "draft" : "reply", row: last }));
    if (this.stopped) return;
    const formed = connector.form.toPosts(output);
    const author = system ? "event" : (said(last)?.author ?? last.author_id);
    const held = draft || formed.held;
    // A reaction leaves at once or not at all: never held, never in the owner's name, never to a connector that cannot.
    const reaction = !held && connector.reacts ? formed.posts.find((post): post is { reaction: string } => "reaction" in post && Boolean(post.reaction.trim())) : undefined;
    const spoken = formed.posts.filter((post): post is { text: string; as?: "owner" } => "text" in post);
    const posts: Post[] = [...(reaction ? [{ reaction: reaction.reaction.trim() }] : []), ...(draft ? spoken.map((post): Post => ({ ...post, as: "owner" })) : spoken)];
    const note = draft ? `${author} mentioned you ${thread.label}: "${said(last)?.text ?? ""}"` : formed.note;
    const texts = posts.flatMap((post) => ("text" in post ? [post.text] : []));
    this.store.recordReply(
      lot,
      posts,
      held,
      { input: lot.map((row) => (row.author_kind === "system" ? (row.text ?? "") : (said(row)?.text ?? ""))).join("\n"), output: texts.join("\n"), author, place: thread.label, ...(!texts.length && formed.note ? { note: formed.note } : {}), ...(reaction ? { reaction: reaction.reaction.trim() } : {}), ...(draft ? { for_owner: true } : held ? { held: true } : {}) },
      {
        ...(draft ? { outcome: "to_owner" } : {}),
        ...(this.config.ownerAddress
          ? { notice: { address: this.config.ownerAddress, threadKey: this.threadKeyOf(this.config.ownerAddress), post: this.notice(lot[0]!.id, thread.label, note, texts) } }
          : {}),
      },
    );
  }

  /** What the owner reads when something waits for him. */
  private notice(batch: number, place: string, note: string | undefined, texts: string[]): Post {
    const commands = this.options.commands ?? [];
    const hints = commands.map((command) => command.hint?.(batch)).filter(Boolean);
    const buttons = commands.flatMap((command) => (command.button ? [command.button(batch)] : []));
    const text = [
      `Waiting for you (#${batch}), ${place}.${note ? ` ${note}` : ""}`,
      texts.map((text) => text.replace(/^/gm, "> ")).join("\n>\n"),
      hints.length ? hints.join(" · ") : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { text, ...(buttons.length ? { buttons } : {}) };
  }

  // --- outbound ------------------------------------------------------------------------------------------------

  private wakeOutbound() {
    if (this.stopped) return;
    for (const row of this.store.ready()) {
      if (this.delivering.has(row.id)) continue;
      this.delivering.add(row.id);
      const delivery = this.deliver(row).finally(() => {
        this.delivering.delete(row.id);
        this.inFlight.delete(delivery);
      });
      this.inFlight.add(delivery);
    }
  }

  private async deliver(row: OutboxRecord) {
    const connector = this.connectors.get(row.connector);
    // A reaction lost or refused is not worth an alert.
    const alert = (text: string) => (row.kind === "reaction" ? undefined : text);
    if (!connector) {
      this.store.dead(row, "no_connector", alert(`A message was not sent (no connector ${row.connector}).`));
      return queueMicrotask(() => this.wake());
    }
    if (!this.store.markDelivering(row.id)) return;
    let result: DeliverResult;
    try {
      result = await withTimeout(connector.deliver(row.address, row.payload), this.config.deliverTimeoutMs);
    } catch (error) {
      // Only a crash writes nothing: a SIGTERM still records what happened.
      if (this.killed) return;
      // Timeout or ambiguous error: it may have left. Never sent again.
      this.lost(row, error instanceof Timeout ? "timeout" : "unknown", alert);
      return this.afterDelivery(row);
    }
    if (this.killed) return;
    if (result.ok) this.store.delivered(row, result.ref, result.sent_at);
    else if (result.transient && Date.now() - Date.parse(row.created_at) < this.config.maxRetryAgeMs) this.store.retryLater(row, later(this.backoff(row.attempts)), result.error);
    else this.store.dead(row, result.error, alert(`A message was not sent (${result.error}).`));
    this.afterDelivery(row);
  }

  private afterDelivery(row: OutboxRecord) {
    if (this.stopped) return;
    // The lot over, its thread is free again: the full pass picks it.
    this.wake();
  }

  private lost(row: OutboxRecord, reason: string, alert: (text: string) => string | undefined = (text) => text) {
    this.store.dead(row, reason, alert(`A message may or may not have been sent (${reason}): it is not sent again.`));
    queueMicrotask(() => this.wake());
  }

  // --- alerts and timer ----------------------------------------------------------------------------------------

  /** To the owner; an alert that fails never raises another one. */
  private alert(text: string) {
    const address = this.config.ownerAddress;
    console.error(`alert: ${text}`);
    if (!address) return;
    this.store.enqueue("alert", address.connector, address, this.threadKeyOf(address), { text });
    queueMicrotask(() => this.wake());
  }

  private backoff(retries: number) {
    const steps = this.config.backoffMs;
    return steps[Math.min(retries, steps.length - 1)] ?? 60_000;
  }

  /** One timer, on the next due date. */
  private arm() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const next = this.store.nextDue();
    if (!next) return;
    const target = Date.parse(next);
    // A timer may fire a little before its date: then it waits the rest, so the pass finds the item due.
    const tick = () => {
      const left = target - Date.now();
      if (left > 0) {
        this.timer = setTimeout(tick, Math.min(left, MAX_TIMER_MS));
        this.timer.unref?.();
      } else this.wake();
    };
    this.timer = setTimeout(tick, Math.min(Math.max(target - Date.now(), 0), MAX_TIMER_MS));
    this.timer.unref?.();
  }
}
