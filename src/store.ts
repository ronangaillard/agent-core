import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { tx } from "./db.ts";
import type { Address, AuthorKind, InboxRow, Post } from "./types.ts";

export type InboxRecord = InboxRow & {
  id: number;
  connector: string;
  status: string;
  attempts: number;
  retries: number;
  next_attempt_at: string | null;
  received_at: string;
};

export type OutboxKind = "reply" | "send" | "report" | "alert";

export type OutboxRecord = {
  id: number;
  kind: OutboxKind;
  batch_id: number | null;
  thread_key: string;
  connector: string;
  address: Address;
  payload: Post;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  created_at: string;
};

type Row = Record<string, SQLInputValue>;

const inboxOf = (r: Row): InboxRecord => ({
  id: Number(r.id),
  source_id: String(r.source_id),
  connector: String(r.connector),
  address: JSON.parse(String(r.address)) as Address,
  thread_key: String(r.thread_key),
  mode_key: String(r.mode_key),
  author_id: String(r.author_id),
  author_kind: String(r.author_kind) as AuthorKind,
  owner_only: Boolean(r.owner_only),
  private: Boolean(r.private),
  dm: Boolean(r.dm),
  mentions_agent: Boolean(r.mentions_agent),
  mentions_owner: Boolean(r.mentions_owner),
  sent_at: String(r.sent_at),
  payload: JSON.parse(String(r.payload)) as unknown,
  caught_up: Boolean(r.caught_up),
  status: String(r.status),
  attempts: Number(r.attempts),
  retries: Number(r.retries),
  next_attempt_at: r.next_attempt_at === null ? null : String(r.next_attempt_at),
  received_at: String(r.received_at),
});

const outboxOf = (r: Row): OutboxRecord => ({
  id: Number(r.id),
  kind: String(r.kind) as OutboxKind,
  batch_id: r.batch_id === null ? null : Number(r.batch_id),
  thread_key: String(r.thread_key),
  connector: String(r.connector),
  address: JSON.parse(String(r.address)) as Address,
  payload: JSON.parse(String(r.payload)) as Post,
  status: String(r.status),
  attempts: Number(r.attempts),
  next_attempt_at: r.next_attempt_at === null ? null : String(r.next_attempt_at),
  created_at: String(r.created_at),
});

const now = () => new Date().toISOString();
const placeholders = (ids: number[]) => ids.map(() => "?").join(",");

/** Every read and write of the three tables. Each status change and its event go in one transaction. */
export class Store {
  constructor(readonly db: DatabaseSync) {}

  private event(e: { kind: string; thread_key?: string | null; author_id?: string | null; author_kind?: string | null; private?: boolean; payload?: unknown; ref?: number | null }) {
    this.db
      .prepare("INSERT INTO events (at, kind, thread_key, author_id, author_kind, private, payload, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(now(), e.kind, e.thread_key ?? null, e.author_id ?? null, e.author_kind ?? null, e.private ? 1 : 0, e.payload === undefined ? null : JSON.stringify(e.payload), e.ref ?? null);
  }

  events(threadKey?: string): { kind: string; ref: number | null; payload: unknown }[] {
    const rows = (threadKey ? this.db.prepare("SELECT * FROM events WHERE thread_key = ? ORDER BY id").all(threadKey) : this.db.prepare("SELECT * FROM events ORDER BY id").all()) as Row[];
    return rows.map((r) => ({ kind: String(r.kind), ref: r.ref === null ? null : Number(r.ref), payload: r.payload === null ? null : (JSON.parse(String(r.payload)) as unknown) }));
  }

  // --- inbox ---------------------------------------------------------------------------------------------------

  /** The durable write before any slow work. A duplicate (catch-up, retry) changes nothing: null. */
  ingest(row: InboxRow, connector: string): number | null {
    return tx(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO inbox (source_id, thread_key, mode_key, connector, address, author_id, author_kind, owner_only, private, dm,
             mentions_agent, mentions_owner, sent_at, payload, caught_up, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.source_id, row.thread_key, row.mode_key, connector, JSON.stringify(row.address), row.author_id, row.author_kind,
          row.owner_only ? 1 : 0, row.private ? 1 : 0, row.dm ? 1 : 0, row.mentions_agent ? 1 : 0, row.mentions_owner ? 1 : 0,
          row.sent_at, JSON.stringify(row.payload ?? null), row.caught_up ? 1 : 0, now(),
        );
      if (result.changes === 0) return null;
      const id = Number(result.lastInsertRowid);
      this.event({ kind: "received", thread_key: row.thread_key, author_id: row.author_id, author_kind: row.author_kind, private: row.private, ref: id });
      return id;
    });
  }

  inbox(id: number): InboxRecord | undefined {
    const row = this.db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as Row | undefined;
    return row ? inboxOf(row) : undefined;
  }

  /** Threads whose oldest pending message is due (a thread whose head is in backoff waits, to keep the order). */
  eligibleThreads(): string[] {
    const rows = this.db
      .prepare(
        `SELECT i.thread_key FROM inbox i
         WHERE i.status = 'pending'
           AND i.id = (SELECT MIN(id) FROM inbox WHERE thread_key = i.thread_key AND status = 'pending')
           AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= ?)
         ORDER BY i.id`,
      )
      .all(now()) as Row[];
    return rows.map((r) => String(r.thread_key));
  }

  pending(threadKey: string): InboxRecord[] {
    return (this.db.prepare("SELECT * FROM inbox WHERE thread_key = ? AND status = 'pending' ORDER BY id").all(threadKey) as Row[]).map(inboxOf);
  }

  /** A reply of this thread not yet delivered keeps the thread locked (held does not). */
  hasReplyInFlight(threadKey: string): boolean {
    return this.db.prepare("SELECT 1 FROM outbox WHERE thread_key = ? AND kind = 'reply' AND status IN ('pending', 'delivering') LIMIT 1").get(threadKey) !== undefined;
  }

  /** Counted before the run: a crash or a hard error counts, a transient error gives it back. */
  countAttempt(ids: number[]) {
    this.db.prepare(`UPDATE inbox SET attempts = attempts + 1 WHERE id IN (${placeholders(ids)})`).run(...ids);
  }

  /** A deliberate stop (SIGTERM) is not a failure. */
  uncountAttempt(ids: number[]) {
    this.db.prepare(`UPDATE inbox SET attempts = MAX(attempts - 1, 0) WHERE id IN (${placeholders(ids)}) AND status = 'pending'`).run(...ids);
  }

  /** Transient failure: back to pending later, the attempt given back, the retry counted for the backoff. */
  defer(ids: number[], at: string) {
    this.db
      .prepare(`UPDATE inbox SET attempts = MAX(attempts - 1, 0), retries = retries + 1, next_attempt_at = ? WHERE id IN (${placeholders(ids)}) AND status = 'pending'`)
      .run(at, ...ids);
  }

  close(row: InboxRecord, outcome: string, payload?: unknown) {
    tx(this.db, () => {
      this.db.prepare("UPDATE inbox SET status = 'done', outcome = ?, handled_at = ? WHERE id = ?").run(outcome, now(), row.id);
      this.event({ kind: outcome, thread_key: row.thread_key, author_id: row.author_id, author_kind: row.author_kind, private: row.private, ref: row.id, payload });
    });
  }

  fail(row: InboxRecord, reason: string) {
    tx(this.db, () => {
      this.db.prepare("UPDATE inbox SET status = 'failed', outcome = ?, handled_at = ? WHERE id = ?").run(reason, now(), row.id);
      this.event({ kind: "failed", thread_key: row.thread_key, author_id: row.author_id, author_kind: row.author_kind, private: row.private, ref: row.id, payload: { reason } });
    });
  }

  /**
   * The end of respond(): the posts, the lot closed by its ids, the event with the readable text. One transaction.
   * A held reply not yet approved in this thread is replaced, not doubled.
   */
  recordReply(lot: InboxRecord[], posts: Post[], held: boolean, readable: { input: string; output: string; author?: string; place?: string }) {
    const last = lot[lot.length - 1]!;
    const replied = posts.length > 0;
    tx(this.db, () => {
      if (replied) {
        for (const old of this.db.prepare("SELECT id FROM outbox WHERE thread_key = ? AND kind = 'reply' AND status = 'held'").all(last.thread_key) as Row[]) {
          this.db.prepare("UPDATE outbox SET status = 'dead', reason = 'replaced' WHERE id = ?").run(Number(old.id));
          this.event({ kind: "dead", thread_key: last.thread_key, ref: Number(old.id), payload: { reason: "replaced" } });
        }
        const insert = this.db.prepare(
          "INSERT INTO outbox (kind, batch_id, thread_key, connector, address, payload, status, created_at) VALUES ('reply', ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const post of posts) insert.run(lot[0]!.id, last.thread_key, last.connector, JSON.stringify(last.address), JSON.stringify(post), held ? "held" : "pending", now());
      }
      const ids = lot.map((r) => r.id);
      this.db.prepare(`UPDATE inbox SET status = 'done', outcome = ?, handled_at = ? WHERE id IN (${placeholders(ids)})`).run(replied ? "replied" : "silent", now(), ...ids);
      this.event({ kind: replied ? "drafted" : "silent", thread_key: last.thread_key, author_id: last.author_id, author_kind: last.author_kind, private: lot.some((r) => r.private), ref: lot[0]!.id, payload: readable });
    });
  }

  /** A kept message refused by the bot cap. Its event tells whether the "I'm stopping" post already went. */
  cap(row: InboxRecord, announce: boolean) {
    tx(this.db, () => {
      this.db.prepare("UPDATE inbox SET status = 'failed', outcome = 'capped', handled_at = ? WHERE id = ?").run(now(), row.id);
      this.event({ kind: "capped", thread_key: row.thread_key, author_id: row.author_id, author_kind: row.author_kind, private: row.private, ref: row.id });
      if (announce) {
        this.db
          .prepare("INSERT INTO outbox (kind, batch_id, thread_key, connector, address, payload, status, created_at) VALUES ('send', NULL, ?, ?, ?, ?, 'pending', ?)")
          .run(row.thread_key, row.connector, JSON.stringify(row.address), JSON.stringify({ text: "I'm stopping here; a human can start me again." }), now());
      }
    });
  }

  // --- what the engagement rules read --------------------------------------------------------------------------

  /** Bot or system messages in a row in this thread, up to this one, since the last human and within the window. */
  nonHumanStreak(threadKey: string, uptoId: number, since: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM inbox
         WHERE thread_key = ? AND id <= ? AND author_kind != 'human' AND received_at >= ?
           AND id > (SELECT COALESCE(MAX(id), 0) FROM inbox WHERE thread_key = ? AND author_kind = 'human' AND id <= ?)`,
      )
      .get(threadKey, uptoId, since, threadKey, uptoId) as Row;
    return Number(row.n);
  }

  /** The "I'm stopping" post already went since the last human message of the thread. */
  cappedSinceHuman(threadKey: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM events WHERE kind = 'capped' AND thread_key = ?
             AND id > (SELECT COALESCE(MAX(id), 0) FROM events WHERE kind = 'received' AND thread_key = ? AND author_kind = 'human')
           LIMIT 1`,
        )
        .get(threadKey, threadKey) !== undefined
    );
  }

  /** The agent already spoke in this thread (mention-sticky). */
  agentSpokeIn(threadKey: string): boolean {
    return this.db.prepare("SELECT 1 FROM outbox WHERE thread_key = ? AND kind IN ('reply', 'send') AND status = 'delivered' LIMIT 1").get(threadKey) !== undefined;
  }

  /** When the agent last posted in this thread (catch-up: older messages were already seen). */
  lastDeliveredAt(threadKey: string): string | undefined {
    const row = this.db.prepare("SELECT MAX(sent_at) AS at FROM outbox WHERE thread_key = ? AND status = 'delivered'").get(threadKey) as Row;
    return row.at === null ? undefined : String(row.at);
  }

  /** The newest message received from a connector: the catch-up cursor. */
  lastSourceAt(connector: string): string | undefined {
    const row = this.db.prepare("SELECT MAX(sent_at) AS at FROM inbox WHERE connector = ? AND author_kind != 'system'").get(connector) as Row;
    return row.at === null ? undefined : String(row.at);
  }

  /** The readable exchanges since a date, newest first: what the digest and the search read. */
  exchanges(since: string, limit = 500): { at: string; thread_key: string; author_id: string; private: boolean; payload: Record<string, unknown> }[] {
    return (this.db.prepare("SELECT * FROM events WHERE kind IN ('drafted', 'silent') AND at >= ? ORDER BY id DESC LIMIT ?").all(since, limit) as Row[]).map((r) => ({
      at: String(r.at),
      thread_key: String(r.thread_key),
      author_id: String(r.author_id),
      private: Boolean(r.private),
      payload: (r.payload === null ? {} : JSON.parse(String(r.payload))) as Record<string, unknown>,
    }));
  }

  // --- outbox --------------------------------------------------------------------------------------------------

  /** A post outside a reply: an alert, a report, a send. */
  enqueue(kind: OutboxKind, connector: string, address: Address, threadKey: string, post: Post) {
    this.db
      .prepare("INSERT INTO outbox (kind, batch_id, thread_key, connector, address, payload, status, created_at) VALUES (?, NULL, ?, ?, ?, ?, 'pending', ?)")
      .run(kind, threadKey, connector, JSON.stringify(address), JSON.stringify(post), now());
  }

  outbox(id: number): OutboxRecord | undefined {
    const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as Row | undefined;
    return row ? outboxOf(row) : undefined;
  }

  allOutbox(): OutboxRecord[] {
    return (this.db.prepare("SELECT * FROM outbox ORDER BY id").all() as Row[]).map(outboxOf);
  }

  /** Due posts; within a lot, only its head: post 2 never overtakes post 1. */
  ready(): OutboxRecord[] {
    return (
      this.db
        .prepare(
          `SELECT o.* FROM outbox o
           WHERE o.status = 'pending' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
             AND NOT (o.batch_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM outbox p WHERE p.batch_id = o.batch_id AND p.id < o.id AND p.status IN ('pending', 'delivering')))
           ORDER BY o.id`,
        )
        .all(now()) as Row[]
    ).map(outboxOf);
  }

  /** Before the call. false: someone else took it. */
  markDelivering(id: number): boolean {
    return this.db.prepare("UPDATE outbox SET status = 'delivering' WHERE id = ? AND status = 'pending'").run(id).changes === 1;
  }

  delivered(row: OutboxRecord, ref: string, sentAt: string) {
    tx(this.db, () => {
      this.db.prepare("UPDATE outbox SET status = 'delivered', ref = ?, sent_at = ? WHERE id = ?").run(ref, sentAt, row.id);
      this.event({ kind: "delivered", thread_key: row.thread_key, ref: row.id });
    });
  }

  retryLater(row: OutboxRecord, at: string, error: string) {
    tx(this.db, () => {
      this.db.prepare("UPDATE outbox SET status = 'pending', attempts = attempts + 1, next_attempt_at = ? WHERE id = ?").run(at, row.id);
      this.event({ kind: "delivery_failed", thread_key: row.thread_key, ref: row.id, payload: { error } });
    });
  }

  dead(row: OutboxRecord, reason: string) {
    tx(this.db, () => {
      this.db.prepare("UPDATE outbox SET status = 'dead', reason = ? WHERE id = ?").run(reason, row.id);
      this.event({ kind: "dead", thread_key: row.thread_key, ref: row.id, payload: { reason } });
    });
  }

  /** Still something to deliver in this lot. */
  lotOpen(batchId: number): boolean {
    return this.db.prepare("SELECT 1 FROM outbox WHERE batch_id = ? AND status IN ('pending', 'delivering') LIMIT 1").get(batchId) !== undefined;
  }

  /** At start: what was being delivered when the process died. Never sent again. */
  orphans(): OutboxRecord[] {
    return (this.db.prepare("SELECT * FROM outbox WHERE status = 'delivering' ORDER BY id").all() as Row[]).map(outboxOf);
  }

  /**
   * The next time something becomes due, for the one timer. Only the future: what is due now waits for its wake()
   * (a busy thread frees itself with one), so the timer never spins.
   */
  nextDue(): string | undefined {
    const at = now();
    const row = this.db
      .prepare(
        `SELECT MIN(at) AS at FROM (
           SELECT next_attempt_at AS at FROM inbox WHERE status = 'pending' AND next_attempt_at > ?
           UNION ALL
           SELECT next_attempt_at AS at FROM outbox WHERE status = 'pending' AND next_attempt_at > ?)`,
      )
      .get(at, at) as Row | undefined;
    return row?.at === null || row?.at === undefined ? undefined : String(row.at);
  }
}
