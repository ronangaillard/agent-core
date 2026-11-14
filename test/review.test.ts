import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leftChannel } from "../src/connectors/slack.ts";
import { openDb } from "../src/db.ts";
import { debugServer } from "../src/debug.ts";
import { digest } from "../src/history.ts";
import { Memory } from "../src/memory.ts";
import { ownerCommands } from "../src/owner.ts";
import { Store } from "../src/store.ts";
import { TransientError, type Address, type Brain, type DeliverResult, type Post, type Scope } from "../src/types.ts";
import { echoBrain, FakeConnector, freshDb, makeCore, sleep, waitFor, World } from "./helpers.ts";

const colleague: Scope = { owner: false, requester: "ines", private: false };

test("a failure before the lot (reading the thread, the gate) waits a backoff and gives up, never spins", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  let reads = 0;
  connector.read = async () => {
    reads++;
    throw new Error("channel_not_found");
  };
  const gate: Brain = async () => ({ speak: true });
  const core = makeCore(freshDb(), connector, echoBrain().brain, { modes: { "fake:chan": "triage" }, backoffMs: [40] }, { gate });
  await core.start();
  const id = core.ingest(world.say("anyone?", { thread: "chan", dm: false, author: "paul", ownerOnly: false }), "fake")!;
  await waitFor(() => core.store.inbox(id)?.status === "failed");
  assert.ok(reads <= 3, `read ${reads} times`);
  assert.equal(core.store.inbox(id)?.attempts, 2);
  core.kill();
});

test("catch-up: the cursor moves only when a pass completes; a failed pass is tried again", async () => {
  const world = new World();
  const path = freshDb();
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  new Store(openDb(path)).setCursor("fake", twoHoursAgo);
  const connector = new FakeConnector(world);
  connector.failingCatchUps = 1;
  connector.missed = [{ ...world.say("while you were away", { thread: "dm" }), sent_at: new Date(Date.now() - 3600_000).toISOString() }];
  const core = makeCore(path, connector, echoBrain().brain, { backoffMs: [40] });
  await core.start();
  // A live message during the owed catch-up does not move the cursor past the gap.
  connector.sink!(world.say("live now", { thread: "live" }));
  await sleep(5);
  assert.equal(core.store.cursor("fake"), twoHoursAgo);
  await waitFor(() => connector.catchUps.length === 2);
  await waitFor(() => connector.sent.some((s) => s.address.conversation === "dm"));
  assert.ok(core.store.cursor("fake")! > twoHoursAgo);
  core.kill();
});

test("SIGTERM: a post in flight gets its outcome written, not 'maybe sent'", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  connector.deliverImpl = async (address: Address, post: Post): Promise<DeliverResult> => {
    await sleep(60);
    return connector.post(address, post);
  };
  const core = makeCore(freshDb(), connector, echoBrain().brain);
  await core.start();
  core.ingest(world.say("hi"), "fake");
  await waitFor(() => core.store.allOutbox().some((row) => row.status === "delivering"));
  await core.stop();
  assert.deepEqual(
    core.store.allOutbox().map((row) => row.status),
    ["delivered"],
  );
});

test("a draft in the owner's name stays his: never in anyone else's digest, sent or dropped", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const brain: Brain = async () => ({ messages: ["Sure, I approve the 40k budget."] });
  const core = makeCore(freshDb(), connector, brain, { draftForOwner: true }, { commands: ownerCommands() });
  await core.start();
  const id = core.ingest({ ...world.say("@ronan budget?", { thread: "chan", dm: false, author: "paul", ownerOnly: false, mentionsOwner: true }), private: false }, "fake")!;
  await waitFor(() => core.store.held().length === 1);
  core.ingest(world.say(`drop ${id}`, { thread: "owner" }), "fake");
  await waitFor(() => core.store.held().length === 0);
  assert.doesNotMatch(digest(core.store, "fake:elsewhere", colleague, { ownerId: "ronan", on: true }), /40k/);
  assert.match(digest(core.store, "fake:elsewhere", { owner: true, requester: "ronan", private: true }, { ownerId: "ronan", on: true }), /40k/);
  core.kill();
});

test("catch-up: a reconnection during a running pass runs another pass after it", async () => {
  const world = new World();
  const path = freshDb();
  new Store(openDb(path)).setCursor("fake", new Date(Date.now() - 3600_000).toISOString());
  const connector = new FakeConnector(world);
  connector.catchUpDelayMs = 60;
  const core = makeCore(path, connector, echoBrain().brain, { catchUpAfterMs: 5 });
  await core.start();
  await sleep(10);
  connector.drop();
  await sleep(15);
  connector.reconnect();
  await waitFor(() => connector.catchUps.length === 2, 2000);
  core.kill();
});

test("catch-up: a failing pass is retried on the one timer, five times at most, then an alert", async () => {
  const world = new World();
  const path = freshDb();
  new Store(openDb(path)).setCursor("fake", new Date(Date.now() - 3600_000).toISOString());
  const connector = new FakeConnector(world);
  connector.failingCatchUps = 99;
  const core = makeCore(path, connector, echoBrain().brain, { backoffMs: [10] });
  await core.start();
  await waitFor(() => connector.sent.some((s) => s.address.conversation === "owner" && "text" in s.post && /five times/.test(s.post.text)));
  await sleep(60);
  assert.equal(connector.catchUps.length, 5);
  core.kill();
});

test("a live event not read for a passing reason owes a catch-up, and freezes the cursor", async () => {
  const world = new World();
  const path = freshDb();
  const before = new Date(Date.now() - 3600_000).toISOString();
  new Store(openDb(path)).setCursor("fake", before);
  const connector = new FakeConnector(world);
  const core = makeCore(path, connector, echoBrain().brain);
  await core.start();
  await waitFor(() => connector.catchUps.length === 1);
  await sleep(10);
  connector.toInbox = async () => {
    throw new TransientError("ratelimited");
  };
  connector.sink!(world.say("lost?"));
  await waitFor(() => connector.catchUps.length === 2);
  core.kill();
});

test("a failure before the lot is charged to the row that failed, not to the head", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const gate: Brain = async ({ prompt }) => {
    if (prompt.includes("plain")) throw new Error("gate down");
    return { speak: true };
  };
  const { brain, prompts } = echoBrain();
  const core = makeCore(freshDb(), connector, brain, { modes: { "fake:chan": "triage" }, backoffMs: [500] }, { gate });
  await core.start();
  const mention = core.ingest(world.say("@agent help", { thread: "chan", dm: false, mention: true, author: "paul", ownerOnly: false }), "fake")!;
  const plain = core.ingest(world.say("plain message", { thread: "chan", dm: false, author: "paul", ownerOnly: false }), "fake")!;
  await waitFor(() => core.store.inbox(mention)?.status === "done");
  assert.equal(core.store.inbox(mention)?.attempts, 1);
  assert.equal(core.store.inbox(plain)?.attempts, 1);
  assert.equal(core.store.inbox(plain)?.status, "pending");
  assert.equal(prompts.length, 1);
  core.kill();
});

test("send: two messages to the same place in one turn both leave; a re-run finds both sent", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const team = { address: { connector: "fake", conversation: "team", thread: "main" }, rules: ["all" as const] };
  const core = makeCore(freshDb(), connector, echoBrain().brain, { destinations: { team } });
  const turn = () => ({ scope: { owner: true, requester: "ronan", private: true }, threadKey: "fake:t1", lotIds: [1], connector: "fake", address: { connector: "fake", conversation: "t1", thread: "main" }, sent: new Map<string, number>() });
  const first = turn();
  assert.equal(await core.send(first, "team", "announcement one"), "Sent.");
  assert.equal(await core.send(first, "team", "announcement two"), "Sent.");
  const rerun = turn();
  assert.match(await core.send(rerun, "team", "Announcement 1"), /Already sent/);
  assert.match(await core.send(rerun, "team", "Announcement 2"), /Already sent/);
  assert.equal(connector.sent.filter((s) => s.address.conversation === "team").length, 2);
  core.kill();
});

test("a job that ingests does not make another job run twice", async () => {
  const world = new World();
  const path = freshDb();
  const store = new Store(openDb(path));
  const past = new Date(Date.now() - 1000).toISOString();
  store.setJob("a", past, 60);
  store.setJob("b", past, 60);
  let runsOfB = 0;
  let core: ReturnType<typeof makeCore> | undefined = undefined;
  core = makeCore(path, new FakeConnector(world), echoBrain().brain, {}, {
    jobs: {
      a: { everyMinutes: 60, run: async (c) => void c.ingest(world.say("from job a"), "fake") },
      b: { everyMinutes: 60, run: async () => void runsOfB++ },
    },
  });
  await core.start();
  await sleep(30);
  assert.equal(runsOfB, 1);
  core.kill();
});

test("slack: only 'not in this channel' marks a channel left; Slack's own failures fail the pass", () => {
  const platform = (error: string) => ({ code: "slack_webapi_platform_error", data: { error } });
  assert.equal(leftChannel(platform("not_in_channel")), true);
  assert.equal(leftChannel(platform("channel_not_found")), true);
  assert.equal(leftChannel(platform("is_archived")), true);
  assert.equal(leftChannel(platform("internal_error")), false);
  assert.equal(leftChannel(platform("service_unavailable")), false);
  assert.equal(leftChannel({ code: "slack_webapi_rate_limited_error" }), false);
});

test("catch-up: after a series given up, a new debt gets its five tries again", async () => {
  const world = new World();
  const path = freshDb();
  new Store(openDb(path)).setCursor("fake", new Date(Date.now() - 3600_000).toISOString());
  const connector = new FakeConnector(world);
  connector.failingCatchUps = 5;
  const core = makeCore(path, connector, echoBrain().brain, { backoffMs: [10], catchUpAfterMs: 5 });
  await core.start();
  await waitFor(() => connector.catchUps.length === 5);
  await sleep(40);
  // A later outage: one failure, then the service is fine again.
  connector.failingCatchUps = 1;
  connector.drop();
  await sleep(15);
  connector.reconnect();
  await waitFor(() => connector.catchUps.length === 7);
  assert.equal(core.store.catchUpFailures("fake"), 0);
  core.kill();
});

test("a model call that never answers is aborted at the deadline, frees its slot, and is retried", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const signals: AbortSignal[] = [];
  let calls = 0;
  const brain: Brain = async ({ signal }) => {
    signals.push(signal!);
    if (++calls === 1) return new Promise(() => undefined);
    return { messages: ["here at last"] };
  };
  const core = makeCore(freshDb(), connector, brain, { brainTimeoutMs: 50, backoffMs: [20], maxRuns: 1 });
  await core.start();
  const id = core.ingest(world.say("hello?", { thread: "a" }), "fake")!;
  // The only slot is held by the hung call; another thread waits for it.
  core.ingest(world.say("me too", { thread: "b" }), "fake");
  await waitFor(() => connector.sent.some((s) => s.address.conversation === "b"));
  await waitFor(() => connector.sent.some((s) => s.address.conversation === "a"));
  assert.equal(signals[0]!.aborted, true);
  assert.equal(core.store.inbox(id)?.retries, 1);
  assert.equal(core.store.inbox(id)?.attempts, 1);
  core.kill();
});

test("memory: a write is whole or not at all, and leaves no temp file", () => {
  const memory = new Memory(mkdtempSync(join(tmpdir(), "memory-")));
  const owner = { owner: true, requester: "ronan", private: true };
  memory.write("common/INDEX.md", "v1", owner);
  memory.write("common/INDEX.md", "v2", owner);
  assert.equal(memory.read("common/INDEX.md", owner), "v2");
  assert.deepEqual(readdirSync(join(memory.root, "common")), ["INDEX.md"]);
});

test("debug view: password required, read-only, tables listed, rows filtered and escaped", async () => {
  const path = freshDb();
  const store = new Store(openDb(path));
  const world = new World();
  store.ingest({ ...world.say("<script>alert(1)</script> budget"), source_id: "x:1" }, "fake");
  store.ingest({ ...world.say("lunch"), source_id: "x:2" }, "fake");
  const debug = debugServer({ dbPath: path, port: 0, password: "pw" });
  const server = await debug.start();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { authorization: `Basic ${Buffer.from("debug:pw").toString("base64")}` };
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/`, { headers: { authorization: `Basic ${Buffer.from("debug:no").toString("base64")}` } })).status, 401);
  const home = await (await fetch(`${base}/`, { headers: auth })).text();
  assert.match(home, /href="\/t\/inbox">inbox<\/a><\/td><td>2</);
  const filtered = await (await fetch(`${base}/t/inbox?q=budget`, { headers: auth })).text();
  assert.match(filtered, /1 rows/);
  assert.doesNotMatch(filtered, /<script>alert/);
  assert.match(filtered, /&lt;script&gt;/);
  assert.equal((await fetch(`${base}/t/sqlite_master`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/t/inbox%3B%20DROP%20TABLE%20inbox`, { headers: auth })).status, 404);
  assert.equal(store.inbox(1)?.source_id, "x:1");
  await debug.stop();
});
