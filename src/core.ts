import type { DatabaseSync } from "node:sqlite";
import { Store, type InboxRecord, type OutboxRecord } from "./store.ts";
import { TransientError, type Address, type Brain, type Connector, type DeliverResult, type InboxRow, type Scope } from "./types.ts";

export type CoreConfig = {
  /** The owner's id on the connectors (scope owner, mentions). */
  ownerId: string;
  /** The system prompt's first part: who the agent is. */
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
  /** Where alerts go (the owner's DM). None: alerts are only events. */
  alertAddress?: Address;
};

export const defaultConfig: Omit<CoreConfig, "ownerId" | "persona"> = {
  settleHumanMs: 1000,
  settleBotMs: 8000,
  settleMaxMs: 30_000,
  maxRuns: 3,
  backoffMs: [60_000, 5 * 60_000, 30 * 60_000],
  maxRetryAgeMs: 6 * 3600_000,
  deliverTimeoutMs: 30_000,
};

const MAX_TIMER_MS = 2 ** 31 - 1;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

class Timeout extends Error {}
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
  private running = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly options: { db: DatabaseSync; connectors: Connector[]; brain: Brain; config: CoreConfig },
  ) {
    this.store = new Store(options.db);
    for (const connector of options.connectors) this.connectors.set(connector.id, connector);
  }

  private get config() {
    return this.options.config;
  }

  async start() {
    for (const orphan of this.store.orphans()) this.lost(orphan, "unknown");
    for (const connector of this.connectors.values()) {
      connector.onConnected?.(() => this.wakeOutbound());
      await connector.start((raw) => void this.receive(connector, raw));
    }
    this.wake();
  }

  /** SIGTERM: nothing new is picked; the lots in flight get their attempt back (a redeploy is not a failure). */
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const ids of this.lots.values()) this.store.uncountAttempt(ids);
    for (const connector of this.connectors.values()) await connector.stop?.();
  }

  /** Tests: the process dies here, nothing more is written. */
  kill() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async receive(connector: Connector, raw: unknown) {
    if (this.stopped) return;
    try {
      const row = await connector.toInbox(raw);
      if (row) this.ingest(row, connector.id);
    } catch (error) {
      console.error(`${connector.id}: event not read`, error);
    }
  }

  /** Durable first, then the signal. Also the entry of sources (scheduler, webhooks). */
  ingest(row: InboxRow, connector: string): number | null {
    const id = this.store.ingest(row, connector);
    if (id !== null) this.wakeInbound();
    return id;
  }

  wake() {
    this.wakeInbound();
    this.wakeOutbound();
  }

  // --- inbound -------------------------------------------------------------------------------------------------

  wakeInbound() {
    if (this.stopped) return;
    for (const thread of this.store.eligibleThreads()) {
      if (this.running >= this.config.maxRuns) break;
      if (this.busy.has(thread) || this.store.hasReplyInFlight(thread)) continue;
      // Taken before any await: two passes never pick the same thread.
      this.busy.add(thread);
      this.running++;
      void this.handle(thread);
    }
    this.arm();
  }

  /** What the core decides alone, with the row's facts. Step 1: DMs, mentions and system rows. */
  private filter(row: InboxRecord): "kept" | "ignored" {
    if (row.author_kind === "system") return "kept";
    if (row.dm || row.mentions_agent) return "kept";
    return "ignored";
  }

  /** From the head: what can be answered now. A system row goes alone; a failed or ignored row is closed here. */
  private pick(thread: string): InboxRecord[] {
    const lot: InboxRecord[] = [];
    const due = new Date().toISOString();
    for (const row of this.store.pending(thread)) {
      if (row.next_attempt_at && row.next_attempt_at > due) break;
      if (row.attempts >= 2) {
        this.store.fail(row, "attempts");
        this.alert(`Message given up after two attempts (${row.source_id}).`);
        continue;
      }
      if (this.filter(row) === "ignored") {
        this.store.close(row, "ignored");
        continue;
      }
      if (row.author_kind === "system") {
        if (lot.length === 0) lot.push(row);
        break;
      }
      lot.push(row);
    }
    return lot;
  }

  /** Waits for the thread to go quiet, re-armed at each new message, capped; then the lot is fixed. */
  private async settle(thread: string, lot: InboxRecord[]): Promise<InboxRecord[]> {
    if (lot[0]?.author_kind === "system") return lot;
    const started = Date.now();
    for (;;) {
      const quiet = lot.some((row) => row.author_kind === "bot") ? this.config.settleBotMs : this.config.settleHumanMs;
      const wait = Math.min(quiet, this.config.settleMaxMs - (Date.now() - started));
      if (wait <= 0) return lot;
      await sleep(wait);
      if (this.stopped) return [];
      const again = this.pick(thread);
      if (again.length === lot.length) return again;
      lot = again;
      if (lot.length === 0) return lot;
    }
  }

  private async handle(thread: string) {
    let ids: number[] = [];
    try {
      const lot = await this.settle(thread, this.pick(thread));
      if (lot.length === 0 || this.stopped) return;
      ids = lot.map((row) => row.id);
      this.store.countAttempt(ids);
      this.lots.set(thread, ids);
      await this.respond(lot);
    } catch (error) {
      if (this.stopped || ids.length === 0) return;
      const head = this.store.inbox(ids[0]!);
      if (error instanceof TransientError && head) {
        if (Date.now() - Date.parse(head.received_at) > this.config.maxRetryAgeMs) {
          for (const id of ids) {
            const row = this.store.inbox(id);
            if (row?.status === "pending") this.store.fail(row, "late");
          }
          this.alert(`No reply possible for ${Math.round(this.config.maxRetryAgeMs / 3600_000)} h (${head.source_id}).`);
        } else {
          this.store.defer(ids, later(this.backoff(head.retries)));
        }
      } else {
        // Counted: the next pass retries once, then gives up.
        console.error(`respond (${thread}) failed`, error);
      }
    } finally {
      this.lots.delete(thread);
      this.busy.delete(thread);
      this.running--;
      if (!this.stopped) {
        this.wakeOutbound();
        this.wakeInbound();
      }
    }
  }

  /** The rights come from the rows, never from the model: the most restricted of the lot. */
  private scopeOf(lot: InboxRecord[]): Scope {
    const last = lot[lot.length - 1]!;
    return {
      owner: lot.every((row) => row.author_kind === "human" && row.owner_only && row.author_id === this.config.ownerId),
      requester: last.author_id,
      private: lot.some((row) => row.private),
    };
  }

  private async respond(lot: InboxRecord[]) {
    const last = lot[lot.length - 1]!;
    const connector = this.connectors.get(last.connector);
    if (!connector) throw new Error(`unknown connector: ${last.connector}`);
    const scope = this.scopeOf(lot);
    void connector.typing?.(last.address).catch(() => undefined);
    const thread = await connector.read(last.address);
    const transcript = thread.messages.map((m) => `${m.author}: ${m.text}`).join("\n");
    const late = lot.some((row) => row.caught_up) ? "\nSome messages arrived while you were away: take it into account." : "";
    const prompt = `The conversation (${thread.label}), oldest first:\n<conversation>\n${transcript}\n</conversation>\n\nThe last ${lot.length} message(s) are new: answer them.${late}`;
    const system = `${this.config.persona}\n\n${connector.form.guide(last, scope)}`;
    const schema = connector.form.schema(last, scope);
    const output = schema.parse(await this.options.brain({ system, prompt, schema }));
    if (this.stopped) return;
    const { posts, held } = connector.form.toPosts(output);
    const input = lot.map((row) => thread.messages.find((m) => m.at === row.sent_at)?.text ?? "").join("\n");
    this.store.recordReply(lot, posts, held, { input, output });
  }

  // --- outbound ------------------------------------------------------------------------------------------------

  wakeOutbound() {
    if (this.stopped) return;
    for (const row of this.store.ready()) {
      if (this.delivering.has(row.id)) continue;
      this.delivering.add(row.id);
      void this.deliver(row).finally(() => this.delivering.delete(row.id));
    }
    this.arm();
  }

  private async deliver(row: OutboxRecord) {
    const connector = this.connectors.get(row.connector);
    if (!connector) return this.store.dead(row, "no_connector");
    if (!this.store.markDelivering(row.id)) return;
    let result: DeliverResult;
    try {
      result = await withTimeout(connector.deliver(row.address, row.payload), this.config.deliverTimeoutMs);
    } catch (error) {
      if (this.stopped) return;
      // Timeout or ambiguous error: it may have left. Never sent again.
      this.lost(row, error instanceof Timeout ? "timeout" : "unknown");
      return this.afterDelivery(row);
    }
    if (this.stopped) return;
    if (result.ok) this.store.delivered(row, result.ref, result.sent_at);
    else if (result.transient && Date.now() - Date.parse(row.created_at) < this.config.maxRetryAgeMs) this.store.retryLater(row, later(this.backoff(row.attempts)), result.error);
    else {
      this.store.dead(row, result.error);
      if (row.kind !== "alert") this.alert(`A message was not sent (${result.error}).`);
    }
    this.afterDelivery(row);
  }

  private afterDelivery(row: OutboxRecord) {
    if (this.stopped) return;
    // The lot is over: the thread is free again.
    if (row.batch_id === null || !this.store.lotOpen(row.batch_id)) this.wakeInbound();
    this.wakeOutbound();
  }

  private lost(row: OutboxRecord, reason: string) {
    this.store.dead(row, reason);
    if (row.kind !== "alert") this.alert(`A message may or may not have been sent (${reason}): it is not sent again.`);
  }

  // --- alerts and timer ----------------------------------------------------------------------------------------

  /** To the owner; an alert that fails never raises another one. */
  private alert(text: string) {
    const address = this.config.alertAddress;
    console.error(`alert: ${text}`);
    if (!address) return;
    this.store.enqueue("alert", address.connector, address, `${address.connector}:${address.conversation}:${address.thread}`, { text });
    queueMicrotask(() => this.wakeOutbound());
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
    const delay = Math.min(Math.max(Date.parse(next) - Date.now(), 0), MAX_TIMER_MS);
    this.timer = setTimeout(() => this.wake(), delay);
    this.timer.unref?.();
  }
}
