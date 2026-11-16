import assert from "node:assert/strict";
import { test } from "node:test";
import { StatusFeed, statusServer, type Status } from "../src/status.ts";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { freshDb } from "./helpers.ts";

test("status: the activity folds into one state, a moment falls back to idle, a running task to coding", () => {
  const store = new Store(openDb(freshDb()));
  const feed = new StatusFeed(store);
  const seen: string[] = [];
  feed.watch((s) => seen.push(`${s.state}${s.detail ? `:${s.detail}` : ""}`));
  const emit = (kind: string, payload?: unknown, ref?: number) => store.activity.emit("event", { kind, thread_key: "slack:C1:main", ...(ref ? { ref } : {}), payload });
  emit("received");
  emit("thinking", { model: "reply" });
  emit("tool_start", { tool: "notion-search" });
  emit("tool_start", { tool: "notion-search" }); // the same: no change told
  emit("drafted");
  emit("delivering");
  emit("delivered");
  emit("task_started", { title: "fix", repo: "maestro-tech/still-maestro" }, 7);
  emit("received", undefined);
  emit("silent");
  emit("task_waiting", undefined, 7);
  assert.deepEqual(seen, ["idle", "received:slack", "thinking", "tool:notion-search", "idle", "writing", "idle", "coding:still-maestro", "received:slack", "coding:still-maestro", "idle"]);
  store.activity.emit("event", { kind: "received", thread_key: "email:abc", author_kind: "human" });
  assert.equal(feed.now().detail, "email");
  store.activity.emit("event", { kind: "received", thread_key: "github:acme/app:main", author_kind: "system" });
  assert.equal(feed.now().detail, "github:event", "an event, and where from");
  assert.equal(feed.now().tasks, 0);
});

test("status: GET /status streams Server-Sent Events, with a bearer token", async () => {
  const store = new Store(openDb(freshDb()));
  const feed = new StatusFeed(store);
  const served = statusServer({ feed, port: 0, token: "s3cret", host: "127.0.0.1" });
  await new Promise((resolve) => served.server.once("listening", resolve));
  const { port } = served.server.address() as { port: number };
  const url = `http://127.0.0.1:${port}/status`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: "Bearer nope" } })).status, 401);
  const abort = new AbortController();
  const res = await fetch(url, { headers: { Authorization: "Bearer s3cret" }, signal: abort.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const next = async (): Promise<Status> => {
    while (!text.includes("\n\n")) text += decoder.decode((await reader.read()).value);
    const [block, ...rest] = text.split("\n\n");
    text = rest.join("\n\n");
    assert.match(block!, /^event: status\ndata: /);
    return JSON.parse(block!.split("data: ")[1]!) as Status;
  };
  assert.equal((await next()).state, "idle");
  store.activity.emit("event", { kind: "tool_start", thread_key: "x", payload: { tool: "memory_read" } });
  const status = await next();
  assert.deepEqual([status.state, status.detail], ["tool", "memory_read"]);
  abort.abort();
  await served.stop();
});
