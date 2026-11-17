import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { TransientError, type Brain, type DeliverResult } from "../src/types.ts";
import { echoBrain, FakeConnector, freshDb, hangingBrain, makeCore, sleep, waitFor, World } from "./helpers.ts";

const repliesIn = (connector: FakeConnector, thread: string) => connector.sent.filter((s) => s.address.conversation === thread);
const alerts = (connector: FakeConnector) => repliesIn(connector, "owner");

test("a DM gets a reply, and every step leaves its event", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { brain } = echoBrain();
  const core = makeCore(freshDb(), connector, brain);
  await core.start();
  core.ingest(world.say("hi"), "fake");
  await waitFor(() => repliesIn(connector, "t1").length === 1);
  assert.deepEqual(repliesIn(connector, "t1")[0]!.post, { text: "reply 1" });
  await waitFor(() => core.store.events("fake:t1").some((e) => e.kind === "delivered"));
  assert.deepEqual(
    core.store.events("fake:t1").map((e) => e.kind),
    ["received", "drafted", "delivering", "delivered"],
  );
  core.kill();
});

test("a duplicate source_id is received once", async () => {
  const world = new World();
  const core = makeCore(freshDb(), new FakeConnector(world), echoBrain().brain);
  const row = world.say("hi");
  assert.notEqual(core.store.ingest(row, "fake"), null);
  assert.equal(core.store.ingest(row, "fake"), null);
  core.kill();
});

test("a burst goes out in a single respond()", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { brain, prompts } = echoBrain();
  const core = makeCore(freshDb(), connector, brain, { settleHumanMs: 60 });
  await core.start();
  core.ingest(world.say("one"), "fake");
  await sleep(10);
  core.ingest(world.say("two"), "fake");
  await sleep(10);
  core.ingest(world.say("three"), "fake");
  await waitFor(() => repliesIn(connector, "t1").length === 1);
  await sleep(100);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /The 3 message\(s\) marked \[new\]/);
  core.kill();
});

test("a message arriving while drafting waits for the first reply to be delivered", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const prompts: string[] = [];
  const brain: Brain = async ({ prompt }) => {
    prompts.push(prompt);
    if (prompts.length === 1) await sleep(120);
    return { messages: [`reply ${prompts.length}`] };
  };
  const core = makeCore(freshDb(), connector, brain);
  await core.start();
  core.ingest(world.say("question 1"), "fake");
  await waitFor(() => prompts.length === 1);
  core.ingest(world.say("question 2"), "fake");
  await waitFor(() => repliesIn(connector, "t1").length === 2);
  assert.equal(prompts.length, 2);
  // The second respond() sees the first reply in the thread.
  assert.match(prompts[1]!, /you: reply 1/);
  core.kill();
});

test("outside a DM and without a mention, the message is ignored without calling the model", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { brain, prompts } = echoBrain();
  const core = makeCore(freshDb(), connector, brain);
  await core.start();
  core.ingest(world.say("just talking among ourselves", { dm: false }), "fake");
  await waitFor(() => core.store.events("fake:t1").some((e) => e.kind === "ignored"));
  assert.equal(prompts.length, 0);
  core.kill();
});

test("crash before handling: the message is picked up at start", async () => {
  const world = new World();
  const path = freshDb();
  new Store(openDb(path)).ingest(world.say("are you there?"), "fake");
  const connector = new FakeConnector(world);
  const core = makeCore(path, connector, echoBrain().brain);
  await core.start();
  await waitFor(() => repliesIn(connector, "t1").length === 1);
  core.kill();
});

test("crash during respond(): retried once, then given up with an alert, and the asker is told", async () => {
  const world = new World();
  const path = freshDb();
  const row = world.say("tricky question");

  const first = makeCore(path, new FakeConnector(world), hangingBrain);
  await first.start();
  const id = first.ingest(row, "fake")!;
  await waitFor(() => first.store.inbox(id)?.attempts === 1);
  first.kill();

  const second = makeCore(path, new FakeConnector(world), hangingBrain);
  await second.start();
  await waitFor(() => second.store.inbox(id)?.attempts === 2);
  second.kill();

  const connector = new FakeConnector(world);
  const third = makeCore(path, connector, echoBrain().brain);
  await third.start();
  await waitFor(() => third.store.inbox(id)?.status === "failed");
  await waitFor(() => alerts(connector).length === 1);
  // A DM to the agent: the asker hears it could not answer, once.
  await waitFor(() => repliesIn(connector, "t1").length === 1);
  assert.match(JSON.stringify(repliesIn(connector, "t1")[0]!.post), /could not answer/);
  third.kill();
});

test("SIGTERM during respond() gives the attempt back: a redeploy is not a failure", async () => {
  const world = new World();
  const path = freshDb();
  const core = makeCore(path, new FakeConnector(world), hangingBrain);
  await core.start();
  const id = core.ingest(world.say("hi"), "fake")!;
  await waitFor(() => core.store.inbox(id)?.attempts === 1);
  await core.stop();
  assert.equal(core.store.inbox(id)?.attempts, 0);
  assert.equal(core.store.inbox(id)?.status, "pending");
});

test("crash while delivering: never sent again, an alert to the owner", async () => {
  const world = new World();
  const path = freshDb();
  const stuck = new FakeConnector(world);
  stuck.deliverImpl = () => new Promise(() => undefined);
  const first = makeCore(path, stuck, echoBrain().brain, { deliverTimeoutMs: 60_000 });
  await first.start();
  first.ingest(world.say("hi"), "fake");
  await waitFor(() => first.store.allOutbox().some((o) => o.status === "delivering"));
  first.kill();

  const connector = new FakeConnector(world);
  const second = makeCore(path, connector, echoBrain().brain);
  await second.start();
  await waitFor(() => alerts(connector).length === 1);
  assert.equal(repliesIn(connector, "t1").length, 0);
  const reply = second.store.allOutbox().find((o) => o.kind === "reply")!;
  assert.equal(reply.status, "dead");
  second.kill();
});

test("a delivery timeout is an orphan: not sent again", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  connector.deliverImpl = (address, post) => (address.conversation === "owner" ? Promise.resolve(connector.post(address, post)) : new Promise(() => undefined));
  const core = makeCore(freshDb(), connector, echoBrain().brain, { deliverTimeoutMs: 50 });
  await core.start();
  core.ingest(world.say("hi"), "fake");
  await waitFor(() => alerts(connector).length === 1);
  assert.equal(core.store.allOutbox().find((o) => o.kind === "reply")!.status, "dead");
  core.kill();
});

test("a reply drafted but not yet sent at the crash goes out at restart", async () => {
  const world = new World();
  const path = freshDb();
  const store = new Store(openDb(path));
  const id = store.ingest(world.say("hi"), "fake")!;
  store.recordReply([store.inbox(id)!], [{ text: "already drafted" }], false, { input: "hi", output: "" });
  const connector = new FakeConnector(world);
  const core = makeCore(path, connector, echoBrain().brain);
  await core.start();
  await waitFor(() => repliesIn(connector, "t1").length === 1);
  assert.deepEqual(repliesIn(connector, "t1")[0]!.post, { text: "already drafted" });
  core.kill();
});

test("a transient delivery error is retried later, not given up", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  let calls = 0;
  connector.deliverImpl = async (address, post): Promise<DeliverResult> => (++calls === 1 ? { ok: false, transient: true, error: "ratelimited" } : connector.post(address, post));
  const core = makeCore(freshDb(), connector, echoBrain().brain);
  await core.start();
  core.ingest(world.say("hi"), "fake");
  await waitFor(() => repliesIn(connector, "t1").length === 1);
  assert.ok(core.store.events("fake:t1").some((e) => e.kind === "delivery_failed"));
  assert.equal(alerts(connector).length, 0);
  core.kill();
});

test("a durable delivery error: dead at once and an alert", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  let calls = 0;
  connector.deliverImpl = async (address, post): Promise<DeliverResult> => {
    if (address.conversation === "owner") return connector.post(address, post);
    calls++;
    return { ok: false, transient: false, error: "is_archived" };
  };
  const core = makeCore(freshDb(), connector, echoBrain().brain);
  await core.start();
  core.ingest(world.say("hi"), "fake");
  await waitFor(() => alerts(connector).length === 1);
  await sleep(100);
  assert.equal(calls, 1);
  core.kill();
});

test("a transient model error is deferred then answered, without counting an attempt", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  let calls = 0;
  const brain: Brain = async () => {
    if (++calls === 1) throw new TransientError("overloaded");
    return { messages: ["finally"] };
  };
  const core = makeCore(freshDb(), connector, brain);
  await core.start();
  const id = core.ingest(world.say("hi"), "fake")!;
  await waitFor(() => repliesIn(connector, "t1").length === 1);
  assert.equal(calls, 2);
  assert.equal(core.store.inbox(id)?.retries, 1);
  core.kill();
});

test("at most three respond() at once", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  let active = 0;
  let peak = 0;
  const brain: Brain = async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(60);
    active--;
    return { messages: ["ok"] };
  };
  const core = makeCore(freshDb(), connector, brain);
  await core.start();
  for (const thread of ["a", "b", "c", "d", "e"]) core.ingest(world.say("hi", { thread }), "fake");
  await waitFor(() => connector.sent.length === 5);
  assert.equal(peak, 3);
  core.kill();
});

test("a system row is handled alone, never with a human message", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { brain, prompts } = echoBrain();
  const core = makeCore(freshDb(), connector, brain);
  core.ingest(world.say("question"), "fake");
  core.ingest(world.say("reminder: the demo", { kind: "system", author: "scheduler", ownerOnly: false }), "fake");
  await core.start();
  await waitFor(() => repliesIn(connector, "t1").length === 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /The 1 message\(s\) marked \[new\]/);
  core.kill();
});

test("the owner scope needs a human message from the owner, in private", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const core = makeCore(freshDb(), connector, echoBrain().brain);
  await core.start();
  core.ingest(world.say("from the owner", { thread: "a" }), "fake");
  core.ingest(world.say("from Paul", { thread: "b", author: "paul", ownerOnly: false }), "fake");
  await waitFor(() => connector.sent.length === 2);
  const owners = connector.scopes.map((s) => [s.requester, s.owner]);
  assert.deepEqual(new Map(owners as [string, boolean][]), new Map([["ronan", true], ["paul", false]]));
  core.kill();
});
