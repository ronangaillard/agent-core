import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Activity, Store } from "./store.ts";

/**
 * What the agent is doing now, for a small screen: a state and a short detail (a tool's name, a repository), never
 * what a message says. idle or coding is the ground state (a code task running or not); the others are moments.
 */
export type StatusState = "idle" | "received" | "thinking" | "tool" | "writing" | "coding";
export type Status = { state: StatusState; detail?: string; tasks: number; at: string };

/** Whatever shows the status (a small screen, the Pals Office): it watches a StatusFeed and stops with the agent. */
export type StatusSink = { stop(): Promise<void> };

/** A moment with nothing after it falls back to the ground state (a run cut short, a silent triage). */
const SETTLE_MS = 120_000;
/** A message received is only a blink: then back to what the agent was doing (a run under way), or the ground. */
const RECEIVED_MS = 2_000;
/** A comment line now and then, so that a proxy (Cloudflare) keeps an idle stream open. */
const HEARTBEAT_MS = 25_000;

/** Folds the activity into one current status, told to listeners on every change. */
export class StatusFeed {
  private current: Status;
  private readonly tasks = new Map<number, string>();
  private readonly listeners = new Set<(status: Status) => void>();
  private settle: NodeJS.Timeout | undefined;
  /** What a run under way is doing (thinking, a tool, writing): where a received blink goes back to. */
  private working: Status | undefined;

  constructor(private readonly store: Store) {
    for (const task of store.tasksWith("running")) this.tasks.set(task.id, task.repo);
    this.current = this.ground();
    store.activity.on("event", (activity) => this.fold(activity));
  }

  now(): Status {
    return this.current;
  }

  /** Called with the status now, then on every change; returns how to stop. */
  watch(listener: (status: Status) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  private ground(): Status {
    const repo = [...this.tasks.values()].at(-1);
    return { state: repo ? "coding" : "idle", ...(repo ? { detail: repo.split("/").at(-1)! } : {}), tasks: this.tasks.size, at: new Date().toISOString() };
  }

  private set(state: StatusState | "ground", detail?: string) {
    clearTimeout(this.settle);
    const next = state === "ground" ? this.ground() : { state, ...(detail ? { detail } : {}), tasks: this.tasks.size, at: new Date().toISOString() };
    if (state === "ground") this.working = undefined;
    else if (state !== "received") this.working = next;
    if (state === "received") {
      this.settle = setTimeout(() => (this.working ? this.set(this.working.state, this.working.detail) : this.set("ground")), RECEIVED_MS).unref();
    } else if (state !== "ground") this.settle = setTimeout(() => this.set("ground"), SETTLE_MS).unref();
    if (next.state === this.current.state && next.detail === this.current.detail && next.tasks === this.current.tasks) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }

  private fold(a: Activity) {
    const payload = (a.payload ?? {}) as { tool?: string; repo?: string; model?: string };
    // Started, or running again (a task continued after its report): its repository from the store if not told.
    if ((a.kind === "task_started" || a.kind === "task_running") && a.ref != null) {
      this.tasks.set(a.ref, payload.repo ?? this.store.task(a.ref)?.repo ?? "code");
      return this.set("ground");
    }
    if (/^task_(waiting|failed|done|abandoned)$/.test(a.kind) && a.ref != null) {
      this.tasks.delete(a.ref);
      return this.set("ground");
    }
    switch (a.kind) {
      // Where it comes from: the connector (the thread key's prefix), and whether it is an event rather than a person.
      case "received": {
        const from = a.thread_key?.split(":")[0] || "?";
        return this.set("received", a.author_kind === "system" ? `${from}:event` : from);
      }
      case "thinking":
        return this.set("thinking", payload.model === "gate" ? "triage" : undefined);
      case "tool_start":
        return this.set("tool", payload.tool);
      case "delivering":
        return this.set("writing");
      // A lot answered (or not), a post gone: back to the ground state.
      case "replied":
      case "silent":
      case "drafted":
      case "ignored":
      case "intercepted":
      case "capped":
      case "failed":
      case "delivered":
      case "delivery_failed":
      case "dead":
        return this.set("ground");
    }
  }
}

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * GET /status: the status as Server-Sent Events (one `status` event at once, then one per change), for a screen
 * that shows what the agent does. Bearer token; meant to be reached through a tunnel. No polling: pushed.
 */
export function statusServer(options: { feed: StatusFeed; port: number; token: string; host?: string }): StatusSink & { server: Server } {
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (req.method !== "GET" || url.pathname !== "/status") return void res.writeHead(404).end();
    if (!sameSecret(req.headers.authorization ?? "", `Bearer ${options.token}`)) return void res.writeHead(401).end();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    streams.add(res);
    const stop = options.feed.watch((status) => res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`));
    const beat = setInterval(() => res.write(": beat\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      stop();
      clearInterval(beat);
      streams.delete(res);
    });
  });
  server.listen(options.port, options.host ?? "0.0.0.0");
  return {
    server,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.end();
        server.close(() => resolve());
      }),
  };
}
