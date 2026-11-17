import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { palsPresence } from "../src/pals.ts";
import { StatusFeed } from "../src/status.ts";
import { Store } from "../src/store.ts";
import { freshDb } from "./helpers.ts";

test("pals: the status becomes signals, stop after a quiet minute, a heartbeat, session_end at the end", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const store = new Store(openDb(freshDb()));
  const sent: string[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const body = JSON.parse(init.body as string) as { event: string; status?: string };
    sent.push(body.status === undefined ? body.event : `${body.event}:${body.status}`);
    return new Response("ok");
  }) as typeof fetch;
  const pals = palsPresence({ feed: new StatusFeed(store), token: "tok", url: "http://office", fetch: fakeFetch });
  // The sends are chained: let them all go.
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const emit = (kind: string, payload?: unknown, ref?: number, thread_key = "slack:C1:main") =>
    store.activity.emit("event", { kind, thread_key, ...(ref ? { ref } : {}), payload });

  await flush();
  assert.deepEqual(sent, ["stop"], "a stale status is cleared at start");
  assert.equal(requests[0]!.url, "http://office/api/presence");
  assert.equal(requests[0]!.init.method, "POST");
  assert.equal((requests[0]!.init.headers as Record<string, string>).Authorization, "Bearer tok");

  emit("received");
  emit("thinking", { model: "gate" });
  emit("thinking", { model: "reply" }); // the same words: not sent again
  emit("tool_start", { tool: "notion-search" });
  emit("delivering");
  emit("delivered");
  await flush();
  assert.deepEqual(sent.splice(0), ["stop", "prompt:Lit un message Slack", "prompt:Réfléchit", "prompt:Utilise notion-search", "prompt:Écrit"]);

  // Activity again within the minute: no stop, and the same words pop the bubble again.
  t.mock.timers.tick(30_000);
  emit("received", undefined, undefined, "email:abc");
  emit("silent");
  t.mock.timers.tick(30_000);
  emit("received", undefined, undefined, "email:abc");
  emit("silent");
  t.mock.timers.tick(59_999);
  await flush();
  assert.deepEqual(sent.splice(0), ["prompt:Lit un mail", "prompt:Lit un mail"]);
  t.mock.timers.tick(1); // two minutes since the start: the heartbeat falls here too
  await flush();
  assert.deepEqual(sent.splice(0), ["heartbeat", "stop"]);

  // A code task: at his desk for as long as it runs.
  emit("task_started", { repo: "acme/app" }, 7);
  t.mock.timers.tick(120_000);
  await flush();
  assert.deepEqual(sent.splice(0), ["prompt:Code sur app", "heartbeat"]);
  emit("task_done", undefined, 7);
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(sent.splice(0), ["stop"]);

  await pals.stop();
  assert.deepEqual(sent.splice(0), ["session_end"]);
  emit("received");
  t.mock.timers.tick(600_000);
  await flush();
  assert.deepEqual(sent, [], "nothing after the end");
});

test("pals: a failure is logged once per distinct message, and never thrown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const errors = t.mock.method(console, "error", () => {});
  let status = 500;
  const fakeFetch = (async () => new Response("down", { status })) as typeof fetch;
  const pals = palsPresence({ feed: new StatusFeed(new Store(openDb(freshDb()))), token: "tok", fetch: fakeFetch });
  t.mock.timers.tick(120_000);
  t.mock.timers.tick(120_000);
  for (let i = 0; i < 30; i++) await Promise.resolve(); // the stop and two heartbeats, all refused the same way
  status = 401;
  await pals.stop();
  assert.deepEqual(
    errors.mock.calls.map((c) => c.arguments[0]),
    ["pals: stop not sent: HTTP 500 down", "pals: session_end not sent: HTTP 401 down"],
  );
});
