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

export type ReminderRecord = {
  id: number;
  kind: "reminder" | "job";
  job: string | null;
  due_at: string;
  repeat_minutes: number | null;
  note: string;
  connector: string | null;
  address: Address | null;
  thread_key: string | null;
  created_by: string | null;
  private: boolean;
};

const reminderOf = (r: Row): ReminderRecord => ({
  id: Number(r.id),
  kind: String(r.kind) as ReminderRecord["kind"],
  job: r.job === null ? null : String(r.job),
  due_at: String(r.due_at),
  repeat_minutes: r.repeat_minutes === null ? null : Number(r.repeat_minutes),
  note: String(r.note),
  connector: r.connector === null ? null : String(r.connector),
  address: r.address === null ? null : (JSON.parse(String(r.address)) as Address),
  thread_key: r.thread_key === null ? null : String(r.thread_key),
  created_by: r.created_by === null ? null : String(r.created_by),
  private: Boolean(r.private),
});

export type TaskStatus = "running" | "waiting" | "done" | "abandoned";

export type TaskRecord = {
  id: number;
  connector: string;
  address: Address;
  thread_key: string;
  title: string;
  repo: string;
  branch: string;
  pr: number | null;
  status: TaskStatus;
  /** The latest request: what a restart runs again. */
  request: string;
  requester: string;
  owner_asked: boolean;
  private: boolean;
  resumes: number;
  created_at: string;
  updated_at: string;
};

const taskOf = (r: Row): TaskRecord => ({
  id: Number(r.id),
  connector: String(r.connector),
  address: JSON.parse(String(r.address)) as Address,
  thread_key: String(r.thread_key),
  title: String(r.title),
  repo: String(r.repo),
  branch: String(r.branch),
  pr: r.pr === null ? null : Number(r.pr),
  status: String(r.status) as TaskStatus,
  request: String(r.request),
  requester: String(r.requester),
  owner_asked: Boolean(r.owner_asked),
  private: Boolean(r.private),
  resumes: Number(r.resumes),
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});

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
  ...(r.text === null || r.text === undefined ? {} : { text: String(r.text) }),
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
  /** Where alerts go (the owner's line), written in the same transaction as what raised them. */
  alertTo: { address: Address; threadKey: string } | undefined;

  constructor(readonly db: DatabaseSync) {}

  private insertAlert(text: string | undefined) {
    if (!text || !this.alertTo) return;
    const { address, threadKey } = this.alertTo;
    this.db
      .prepare("INSERT INTO outbox (kind, batch_id, thread_key, connector, address, payload, status, created_at) VALUES ('alert', NULL, ?, ?, ?, ?, 'pending', ?)")
      .run(threadKey, address.connector, JSON.stringify(address), JSON.stringify({ text }), now());
  }

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
    return tx(this.db, () => this.insertInbox(row, connector));
  }

  /** Inside a transaction already open. */
  private insertInbox(row: InboxRow, connector: string): number | null {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox (source_id, thread_key, mode_key, connector, address, author_id, author_kind, owner_only, private, dm,
           mentions_agent, mentions_owner, sent_at, payload, text, caught_up, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.source_id, row.thread_key, row.mode_key, connector, JSON.stringify(row.address), row.author_id, row.author_kind,
        row.owner_only ? 1 : 0, row.private ? 1 : 0, row.dm ? 1 : 0, row.mentions_agent ? 1 : 0, row.mentions_owner ? 1 : 0,
        row.sent_at, JSON.stringify(row.payload ?? null), row.text ?? null, row.caught_up ? 1 : 0, now(),
      );
    if (result.changes === 0) return null;
    const id = Number(result.lastInsertRowid);
    this.event({ kind: "received", thread_key: row.thread_key, author_id: row.author_id, author_kind: row.author_kind, private: row.private, ref: id });
    return id;
  }

  // --- what waits for the owner --------------------------------------------------------------------------------

  /** The held lots, oldest first: one entry per lot, its number is the lot's batch_id. */
  held(): { batch: number; thread_key: string; address: Address; texts: string[]; created_at: string }[] {
    const rows = (this.db.prepare("SELECT * FROM outbox WHERE status = 'held' ORDER BY id").all() as Row[]).map(outboxOf);
    const lots = new Map<number, { batch: number; thread_key: string; address: Address; texts: string[]; created_at: string }>();
    for (const row of rows) {
      const batch = row.batch_id ?? row.id;
      const lot = lots.get(batch) ?? { batch, thread_key: row.thread_key, address: row.address, texts: [], created_at: row.created_at };
      lot.texts.push("text" in row.payload ? row.payload.text : "");
      lots.set(batch, lot);
    }
    return [...lots.values()];
  }

  /** The owner lets a held lot leave, its text replaced if he edited it (then a single post). false: nothing held. */
  release(batch: number, text?: string): boolean {
    return tx(this.db, () => {
      const rows = (this.db.prepare("SELECT * FROM outbox WHERE batch_id = ? AND status = 'held' ORDER BY id").all(batch) as Row[]).map(outboxOf);
      const [first, ...rest] = rows;
      if (!first) return false;
      if (text !== undefined) {
        this.db.prepare("UPDATE outbox SET payload = ? WHERE id = ?").run(JSON.stringify({ ...first.payload, text }), first.id);
        for (const row of rest) {
          this.db.prepare("UPDATE outbox SET status = 'dead', reason = 'edited' WHERE id = ?").run(row.id);
          this.event({ kind: "dead", thread_key: row.thread_key, ref: row.id, payload: { reason: "edited" } });
        }
      }
      this.db.prepare("UPDATE outbox SET status = 'pending' WHERE batch_id = ? AND status = 'held'").run(batch);
      this.event({ kind: "released", thread_key: first.thread_key, ref: batch, payload: text === undefined ? undefined : { edited: true } });
      return true;
    });
  }

  discard(batch: number): boolean {
    return tx(this.db, () => {
      const rows = (this.db.prepare("SELECT * FROM outbox WHERE batch_id = ? AND status = 'held'").all(batch) as Row[]).map(outboxOf);
      for (const row of rows) {
        this.db.prepare("UPDATE outbox SET status = 'dead', reason = 'dropped' WHERE id = ?").run(row.id);
        this.event({ kind: "dead", thread_key: row.thread_key, ref: row.id, payload: { reason: "dropped" } });
      }
      return rows.length > 0;
    });
  }

  /** An owner's command: the row closed as intercepted, the answer queued in its thread, together. */
  intercept(row: InboxRecord, answer: string) {
    tx(this.db, () => {
      this.db.prepare("UPDATE inbox SET status = 'done', outcome = 'intercepted', handled_at = ? WHERE id = ?").run(now(), row.id);
      this.event({ kind: "intercepted", thread_key: row.thread_key, author_id: row.author_id, author_kind: row.author_kind, private: row.private, ref: row.id });
      this.db
        .prepare("INSERT INTO outbox (kind, batch_id, thread_key, connector, address, payload, status, created_at) VALUES ('reply', ?, ?, ?, ?, ?, 'pending', ?)")
        .run(row.id, row.thread_key, row.connector, JSON.stringify(row.address), JSON.stringify({ text: answer }), now());
    });
  }

  // --- code tasks ----------------------------------------------------------------------------------------------

  createTask(t: { connector: string; address: Address; thread_key: string; title: string; repo: string; request: string; requester: string; owner_asked: boolean; private: boolean }): TaskRecord {
    return tx(this.db, () => {
      const at = now();
      const result = this.db
        .prepare(
          `INSERT INTO tasks (connector, address, thread_key, title, repo, branch, status, request, requester, owner_asked, private, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '', 'running', ?, ?, ?, ?, ?, ?)`,
        )
        .run(t.connector, JSON.stringify(t.address), t.thread_key, t.title, t.repo, t.request, t.requester, t.owner_asked ? 1 : 0, t.private ? 1 : 0, at, at);
      const id = Number(result.lastInsertRowid);
      const slug = t.title.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      this.db.prepare("UPDATE tasks SET branch = ? WHERE id = ?").run(`agent/${id}${slug ? `-${slug}` : ""}`, id);
      this.event({ kind: "task_started", thread_key: t.thread_key, author_id: t.requester, private: t.private, ref: id, payload: { title: t.title, repo: t.repo } });
      return this.task(id)!;
    });
  }

  task(id: number): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? taskOf(row) : undefined;
  }

  /** Running or waiting in this conversation. */
  openTasks(threadKey: string): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE thread_key = ? AND status IN ('running', 'waiting') ORDER BY id").all(threadKey) as Row[]).map(taskOf);
  }

  /** Running or waiting anywhere, and those finished since this date: newest first. */
  recentTasks(since: string): TaskRecord[] {
    return (
      this.db.prepare("SELECT * FROM tasks WHERE status IN ('running', 'waiting') OR (status = 'done' AND updated_at >= ?) ORDER BY updated_at DESC LIMIT 20").all(since) as Row[]
    ).map(taskOf);
  }

  tasksWith(status: TaskStatus): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY id").all(status) as Row[]).map(taskOf);
  }

  /** A change of the task, its event with it; a report to its conversation too, when there is one. */
  updateTask(id: number, fields: Partial<Pick<TaskRecord, "status" | "pr" | "request" | "requester" | "owner_asked" | "resumes">>, report?: string, alert?: string) {
    tx(this.db, () => {
      const task = this.task(id);
      if (!task) return;
      const columns = Object.keys(fields);
      if (columns.length) {
        const values = Object.values(fields).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null)) as SQLInputValue);
        this.db.prepare(`UPDATE tasks SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
      }
      if (fields.status) this.event({ kind: `task_${fields.status}`, thread_key: task.thread_key, private: task.private, ref: id });
      this.insertAlert(alert);
      if (report) {
        this.db
          .prepare("INSERT INTO outbox (kind, batch_id, thread_key, connector, address, payload, status, created_at) VALUES ('report', NULL, ?, ?, ?, ?, 'pending', ?)")
          .run(task.thread_key, task.connector, JSON.stringify(task.address), JSON.stringify({ text: report }), now());
      }
    });
  }

  // --- reminders and jobs --------------------------------------------------------------------------------------

  addReminder(r: { due_at: string; repeat_minutes: number | null; note: string; connector: string; address: Address; thread_key: string; created_by: string; private: boolean }): number {
    return tx(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT INTO reminders (kind, due_at, repeat_minutes, note, connector, address, thread_key, created_by, private, created_at)
           VALUES ('reminder', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.due_at, r.repeat_minutes, r.note, r.connector, JSON.stringify(r.address), r.thread_key, r.created_by, r.private ? 1 : 0, now());
      const id = Number(result.lastInsertRowid);
      this.event({ kind: "reminder_set", thread_key: r.thread_key, author_id: r.created_by, private: r.private, ref: id, payload: { note: r.note, due_at: r.due_at } });
      return id;
    });
  }

  /** A job: a named function on a schedule, never visible to the tools. Set again at each start, same name. */
  setJob(name: string, dueAt: string, repeatMinutes: number | null) {
    this.db
      .prepare(
        `INSERT INTO reminders (kind, job, due_at, repeat_minutes, note, created_at) VALUES ('job', ?, ?, ?, '', ?)
         ON CONFLICT(job) DO UPDATE SET repeat_minutes = excluded.repeat_minutes`,
      )
      .run(name, dueAt, repeatMinutes, now());
  }

  reminders(threadKey: string): ReminderRecord[] {
    return (this.db.prepare("SELECT * FROM reminders WHERE kind = 'reminder' AND thread_key = ? ORDER BY due_at").all(threadKey) as Row[]).map(reminderOf);
  }

  cancelReminder(id: number, threadKey: string): boolean {
    return this.db.prepare("DELETE FROM reminders WHERE id = ? AND kind = 'reminder' AND thread_key = ?").run(id, threadKey).changes === 1;
  }

  upcomingReminders(limit: number): ReminderRecord[] {
    return (this.db.prepare("SELECT * FROM reminders WHERE kind = 'reminder' ORDER BY due_at LIMIT ?").all(limit) as Row[]).map(reminderOf);
  }

  dueReminders(): ReminderRecord[] {
    return (this.db.prepare("SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at").all(now()) as Row[]).map(reminderOf);
  }

  /**
   * One transaction: the system row in the inbox (its source_id makes a second firing a no-op) and the reminder
   * re-armed or deleted. A crash in between can neither lose nor double it.
   */
  fire(reminder: ReminderRecord, next: string | null, row: InboxRow | null): boolean {
    return tx(this.db, () => {
      // Fired already (another pass, a re-entry): nothing.
      if (!this.db.prepare("SELECT 1 FROM reminders WHERE id = ? AND due_at = ?").get(reminder.id, reminder.due_at)) return false;
      if (row && reminder.connector) {
        const id = this.insertInbox(row, reminder.connector);
        if (id !== null) this.event({ kind: "reminder_due", thread_key: row.thread_key, private: row.private, ref: id, payload: { reminder: reminder.id } });
      }
      if (next) this.db.prepare("UPDATE reminders SET due_at = ? WHERE id = ?").run(next, reminder.id);
      else this.db.prepare("DELETE FROM reminders WHERE id = ?").run(reminder.id);
      return true;
    });
  }

  // --- acting elsewhere ----------------------------------------------------------------------------------------

  /**
   * A send, before the call: the outbox row (delivering) and the acted event in the conversation that asked, in one
   * transaction. A re-run after a crash sees the acted event; the key stops the same send twice. null: already done.
   */
  startSend(s: { idem_key: string; thread_key: string; target_thread: string; connector: string; address: Address; post: Post; private: boolean; summary: string }): number | null {
    return tx(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO outbox (kind, batch_id, thread_key, connector, address, payload, status, idem_key, created_at)
           VALUES ('send', NULL, ?, ?, ?, ?, 'delivering', ?, ?)`,
        )
        .run(s.target_thread, s.connector, JSON.stringify(s.address), JSON.stringify(s.post), s.idem_key, now());
      if (result.changes === 0) return null;
      const id = Number(result.lastInsertRowid);
      this.event({ kind: "acted", thread_key: s.thread_key, private: s.private, ref: id, payload: { tool: "send", summary: s.summary } });
      return id;
    });
  }

  /** A send Slack refused for sure: the key is freed, so the model may try again. */
  freeKey(id: number) {
    this.db.prepare("UPDATE outbox SET idem_key = NULL WHERE id = ?").run(id);
  }

  /** What the agent already did from this conversation (sends, reminders), for the prompt of a re-run. */
  acted(threadKey: string): string[] {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const rows = this.db.prepare("SELECT payload FROM events WHERE thread_key = ? AND kind IN ('acted', 'reminder_set') AND at > ? ORDER BY id DESC LIMIT 10").all(threadKey, since) as Row[];
    return rows.reverse().map((r) => {
      const payload = JSON.parse(String(r.payload ?? "{}")) as { summary?: string; note?: string; due_at?: string };
      return payload.summary ?? `reminder set for ${payload.due_at}: ${payload.note}`;
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

  /** A failure that counts (the attempt stays): not retried before this date, so a failing thread never spins. */
  delay(ids: number[], at: string) {
    this.db.prepare(`UPDATE inbox SET next_attempt_at = ? WHERE id IN (${placeholders(ids)}) AND status = 'pending'`).run(at, ...ids);
  }

  /** Transient failure: back to pending later, the attempt given back, the retry counted for the backoff. */
  defer(ids: number[], at: string, counted = true) {
    this.db
      .prepare(`UPDATE inbox SET attempts = MAX(attempts - ?, 0), retries = retries + 1, next_attempt_at = ? WHERE id IN (${placeholders(ids)}) AND status = 'pending'`)
      .run(counted ? 1 : 0, at, ...ids);
  }

  close(row: InboxRecord, outcome: string, payload?: unknown) {
    tx(this.db, () => {
      this.db.prepare("UPDATE inbox SET status = 'done', outcome = ?, handled_at = ? WHERE id = ?").run(outcome, now(), row.id);
      this.event({ kind: outcome, thread_key: row.thread_key, author_id: row.author_id, author_kind: row.author_kind, private: row.private, ref: row.id, payload });
    });
  }

  fail(row: InboxRecord, reason: string, alert?: string) {
    tx(this.db, () => {
      this.db.prepare("UPDATE inbox SET status = 'failed', outcome = ?, handled_at = ? WHERE id = ?").run(reason, now(), row.id);
      this.event({ kind: "failed", thread_key: row.thread_key, author_id: row.author_id, author_kind: row.author_kind, private: row.private, ref: row.id, payload: { reason } });
      this.insertAlert(alert);
    });
  }

  /**
   * The end of respond(): the posts, the lot closed by its ids, the event with the readable text. One transaction.
   * A held reply not yet approved in this thread is replaced, not doubled.
   */
  recordReply(
    lot: InboxRecord[],
    posts: Post[],
    held: boolean,
    readable: { input: string; output: string; author?: string; place?: string; for_owner?: boolean; held?: boolean },
    options: { outcome?: string; notice?: { address: Address; threadKey: string; text: string } } = {},
  ) {
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
      this.db.prepare(`UPDATE inbox SET status = 'done', outcome = ?, handled_at = ? WHERE id IN (${placeholders(ids)})`).run(options.outcome ?? (replied ? "replied" : "silent"), now(), ...ids);
      // What waits for the owner is announced to him in the same transaction: never a held post he does not know of.
      if (replied && held && options.notice) {
        const { address, threadKey, text } = options.notice;
        this.db
          .prepare("INSERT INTO outbox (kind, batch_id, thread_key, connector, address, payload, status, created_at) VALUES ('report', NULL, ?, ?, ?, ?, 'pending', ?)")
          .run(threadKey, address.connector, JSON.stringify(address), JSON.stringify({ text }), now());
      }
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
    // A post in the owner's name is his, not the agent's.
    return (
      this.db.prepare("SELECT 1 FROM outbox WHERE thread_key = ? AND kind IN ('reply', 'send') AND status = 'delivered' AND json_extract(payload, '$.as') IS NULL LIMIT 1").get(threadKey) !==
      undefined
    );
  }

  /** When the agent last posted in this thread (catch-up: older messages were already seen). */
  lastDeliveredAt(threadKey: string): string | undefined {
    const row = this.db.prepare("SELECT MAX(sent_at) AS at FROM outbox WHERE thread_key = ? AND status = 'delivered'").get(threadKey) as Row;
    return row.at === null ? undefined : String(row.at);
  }

  /** The newest message received from a connector: the catch-up cursor. */
  /** Up to when everything from this connector is known to be in the inbox. */
  cursor(connector: string): string | undefined {
    const row = this.db.prepare("SELECT at FROM cursors WHERE connector = ?").get(connector) as Row | undefined;
    return row ? String(row.at) : (this.lastSourceAt(connector) ?? undefined);
  }

  /** Only forward. */
  setCursor(connector: string, at: string) {
    this.db.prepare("INSERT INTO cursors (connector, at) VALUES (?, ?) ON CONFLICT(connector) DO UPDATE SET at = MAX(at, excluded.at)").run(connector, at);
  }

  /** A catch-up pass completed: the cursor moves, the failures are forgotten. */
  catchUpDone(connector: string, at: string) {
    this.setCursor(connector, at);
    this.db.prepare("UPDATE cursors SET failures = 0, retry_at = NULL WHERE connector = ?").run(connector);
  }

  /** A pass failed: tried again at this date (on the one timer), or not at all past the cap, with an alert. */
  catchUpFailed(connector: string, retryAt: string | null, alert?: string): number {
    return tx(this.db, () => {
      this.db.prepare("INSERT INTO cursors (connector, at) VALUES (?, ?) ON CONFLICT(connector) DO NOTHING").run(connector, now());
      this.db.prepare("UPDATE cursors SET failures = failures + 1, retry_at = ? WHERE connector = ?").run(retryAt, connector);
      this.insertAlert(alert);
      return Number((this.db.prepare("SELECT failures FROM cursors WHERE connector = ?").get(connector) as Row).failures);
    });
  }

  /** A new series of tries, unless one is still waiting for its retry. */
  catchUpReset(connector: string) {
    this.db.prepare("UPDATE cursors SET failures = 0 WHERE connector = ? AND retry_at IS NULL").run(connector);
  }

  catchUpFailures(connector: string): number {
    const row = this.db.prepare("SELECT failures FROM cursors WHERE connector = ?").get(connector) as Row | undefined;
    return row ? Number(row.failures) : 0;
  }

  /** The connectors whose failed catch-up is due again. */
  catchUpsDue(): string[] {
    return (this.db.prepare("SELECT connector FROM cursors WHERE retry_at IS NOT NULL AND retry_at <= ?").all(now()) as Row[]).map((r) => String(r.connector));
  }

  lastSourceAt(connector: string): string | undefined {
    const row = this.db.prepare("SELECT MAX(sent_at) AS at FROM inbox WHERE connector = ? AND author_kind != 'system'").get(connector) as Row;
    return row.at === null ? undefined : String(row.at);
  }

  /** The readable exchanges since a date, newest first: what the digest and the search read. */
  exchanges(since: string, limit = 500): { at: string; ref: number | null; thread_key: string; author_id: string; private: boolean; payload: Record<string, unknown> }[] {
    return (this.db.prepare("SELECT * FROM events WHERE kind IN ('drafted', 'silent') AND at >= ? ORDER BY id DESC LIMIT ?").all(since, limit) as Row[]).map((r) => ({
      at: String(r.at),
      ref: r.ref === null ? null : Number(r.ref),
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
    return tx(this.db, () => {
      const row = this.outbox(id);
      if (!row || this.db.prepare("UPDATE outbox SET status = 'delivering' WHERE id = ? AND status = 'pending'").run(id).changes !== 1) return false;
      this.event({ kind: "delivering", thread_key: row.thread_key, ref: id });
      return true;
    });
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

  /** An alert never raises another one. */
  dead(row: OutboxRecord, reason: string, alert?: string) {
    tx(this.db, () => {
      this.db.prepare("UPDATE outbox SET status = 'dead', reason = ? WHERE id = ?").run(reason, row.id);
      this.event({ kind: "dead", thread_key: row.thread_key, ref: row.id, payload: { reason } });
      if (row.kind !== "alert") this.insertAlert(alert);
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
           SELECT next_attempt_at AS at FROM outbox WHERE status = 'pending' AND next_attempt_at > ?
           UNION ALL
           SELECT due_at AS at FROM reminders WHERE due_at > ?
           UNION ALL
           SELECT retry_at AS at FROM cursors WHERE retry_at > ?)`,
      )
      .get(at, at, at, at) as Row | undefined;
    return row?.at === null || row?.at === undefined ? undefined : String(row.at);
  }
}
