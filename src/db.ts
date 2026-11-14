import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * inbox and outbox carry the state (a status, updated); events keeps the history (append-only). Every status change
 * writes its event in the same transaction. reminders holds what is due later: the reminders the agent set, and jobs.
 * tasks holds the code tasks: one copy, one branch, one PR each, continued across conversations.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL UNIQUE,
  thread_key TEXT NOT NULL,
  mode_key TEXT NOT NULL,
  connector TEXT NOT NULL,
  address TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  owner_only INTEGER NOT NULL,
  private INTEGER NOT NULL,
  dm INTEGER NOT NULL,
  mentions_agent INTEGER NOT NULL,
  mentions_owner INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  text TEXT,
  caught_up INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  received_at TEXT NOT NULL,
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS inbox_thread ON inbox (thread_key, status, id);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  batch_id INTEGER,
  thread_key TEXT NOT NULL,
  connector TEXT NOT NULL,
  address TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  idem_key TEXT UNIQUE,
  ref TEXT,
  sent_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox (status, id);
CREATE INDEX IF NOT EXISTS outbox_thread ON outbox (thread_key, status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  thread_key TEXT,
  author_id TEXT,
  author_kind TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  ref INTEGER
);
CREATE INDEX IF NOT EXISTS events_thread ON events (thread_key, id);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  job TEXT UNIQUE,
  due_at TEXT NOT NULL,
  repeat_minutes REAL,
  note TEXT NOT NULL,
  connector TEXT,
  address TEXT,
  thread_key TEXT,
  created_by TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (due_at);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector TEXT NOT NULL,
  address TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  title TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  pr INTEGER,
  status TEXT NOT NULL,
  request TEXT NOT NULL,
  requester TEXT NOT NULL,
  owner_asked INTEGER NOT NULL,
  private INTEGER NOT NULL,
  resumes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_thread ON tasks (thread_key, status);

CREATE TABLE IF NOT EXISTS cursors (
  connector TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/** One transaction: everything or nothing. */
export function tx<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
