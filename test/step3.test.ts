import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { githubSource } from "../src/sources/github.ts";
import { Store } from "../src/store.ts";
import type { Brain, Scope, ToolContext } from "../src/types.ts";
import { echoBrain, FakeConnector, freshDb, makeCore, sleep, waitFor, World } from "./helpers.ts";

const owner: Scope = { owner: true, requester: "ronan", private: true };
const colleague: Scope = { owner: false, requester: "paul", private: false };
const context = (scope: Scope, thread = "t1", lot = 1): ToolContext => ({
  scope,
  threadKey: `fake:${thread}`,
  lotIds: [lot],
  connector: "fake",
  address: { connector: "fake", conversation: thread, thread: "main" },
});
const team = { address: { connector: "fake", conversation: "team", thread: "main" }, rules: ["all" as const] };
const board = { address: { connector: "fake", conversation: "board", thread: "main" }, rules: ["owner" as const] };
const textsIn = (connector: FakeConnector, thread: string) => connector.sent.filter((s) => s.address.conversation === thread).map((s) => ("text" in s.post ? s.post.text : ""));

test("reminder: set from a conversation, it comes back there as an event the agent answers", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const prompts: string[] = [];
  const brain: Brain = async ({ prompt, tools = [] }) => {
    prompts.push(prompt);
    if (prompt.includes("<event>")) return { messages: ["time to call the bank"] };
    const set = tools.find((t) => t.name === "set_reminder")!;
    assert.match(await set.run({ at: new Date(Date.now() + 150).toISOString(), note: "call the bank" }), /Reminder #1 set/);
    return { messages: ["noted"] };
  };
  const core = makeCore(freshDb(), connector, brain);
  await core.start();
  core.ingest(world.say("remind me to call the bank"), "fake");
  await waitFor(() => textsIn(connector, "t1").includes("time to call the bank"));
  assert.match(prompts[1]!, /call the bank/);
  assert.match(prompts[1]!, /You already did/);
  const kinds = core.store.events("fake:t1").map((e) => e.kind);
  assert.ok(kinds.includes("reminder_set") && kinds.includes("reminder_due"));
  assert.equal(core.store.reminders("fake:t1").length, 0);
  core.kill();
});

test("reminder: a repeating one missed while down fires once, then moves to the next future date", async () => {
  const path = freshDb();
  const store = new Store(openDb(path));
  store.addReminder({
    due_at: new Date(Date.now() - 3.5 * 60_000).toISOString(),
    repeat_minutes: 1,
    note: "stand-up",
    connector: "fake",
    address: { connector: "fake", conversation: "t1", thread: "main" },
    thread_key: "fake:t1",
    created_by: "ronan",
    private: true,
  });
  const world = new World();
  const connector = new FakeConnector(world);
  const core = makeCore(path, connector, echoBrain().brain);
  await core.start();
  await waitFor(() => textsIn(connector, "t1").length === 1);
  await sleep(50);
  assert.equal(core.store.events("fake:t1").filter((e) => e.kind === "reminder_due").length, 1);
  const [next] = core.store.reminders("fake:t1");
  assert.ok(next && Date.parse(next.due_at) > Date.now());
  core.kill();
});

test("reminder: firing the same occurrence twice gives one row", () => {
  const store = new Store(openDb(freshDb()));
  const address = { connector: "fake", conversation: "t1", thread: "main" };
  const at = new Date(Date.now() - 1000).toISOString();
  const id = store.addReminder({ due_at: at, repeat_minutes: null, note: "n", connector: "fake", address, thread_key: "fake:t1", created_by: "ronan", private: true });
  const [due] = store.dueReminders();
  const row = { ...new World().say("n"), source_id: `reminder:${id}:${at}`, author_kind: "system" as const };
  store.fire(due!, null, row);
  store.fire(due!, null, row);
  assert.equal(store.pending("fake:t1").length, 1);
  assert.equal(store.dueReminders().length, 0);
});

test("reminder: at most 5 per conversation, and only that conversation's can be cancelled", async () => {
  const world = new World();
  const core = makeCore(freshDb(), new FakeConnector(world), echoBrain().brain, { maxRemindersPerThread: 5 });
  const at = new Date(Date.now() + 3600_000).toISOString();
  for (let i = 0; i < 5; i++) assert.match(core.remind(context(owner), at, null, `r${i}`), /set/);
  assert.match(core.remind(context(owner), at, null, "one too many"), /cancel one first/);
  const [first] = core.store.reminders("fake:t1");
  assert.equal(core.store.cancelReminder(first!.id, "fake:other"), false);
  assert.equal(core.store.cancelReminder(first!.id, "fake:t1"), true);
  core.kill();
});

test("send: idempotent within a lot, and an ambiguous failure is never retried", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const core = makeCore(freshDb(), connector, echoBrain().brain, { destinations: { team } });
  assert.equal(await core.send(context(owner), "team", "deploy at 5"), "Sent.");
  assert.match(await core.send(context(owner), "team", "deploy at 5"), /Already sent/);
  assert.equal(textsIn(connector, "team").length, 1);
  assert.deepEqual(core.store.acted("fake:t1"), ['sent to team: "deploy at 5"']);

  connector.deliverImpl = async () => {
    throw new Error("socket hang up");
  };
  assert.match(await core.send(context(owner), "team", "second"), /Status unknown/);
  connector.deliverImpl = undefined;
  assert.match(await core.send(context(owner), "team", "second"), /Already sent/);
  assert.equal(textsIn(connector, "team").length, 1);

  connector.deliverImpl = async () => ({ ok: false, transient: false, error: "channel_not_found" });
  assert.match(await core.send(context(owner), "team", "third"), /Not sent: channel_not_found/);
  connector.deliverImpl = undefined;
  assert.equal(await core.send(context(owner), "team", "third"), "Sent.");
  core.kill();
});

test("send: a crash after the write and before the answer leaves the send dead, never sent again", async () => {
  const world = new World();
  const path = freshDb();
  const connector = new FakeConnector(world);
  connector.deliverImpl = () => new Promise(() => undefined);
  const core = makeCore(path, connector, echoBrain().brain, { destinations: { team }, deliverTimeoutMs: 60_000 });
  void core.send(context(owner), "team", "hello");
  await sleep(20);
  core.kill();
  const again = new FakeConnector(world);
  const restarted = makeCore(path, again, echoBrain().brain, { destinations: { team } });
  await restarted.start();
  const send = restarted.store.allOutbox().find((row) => row.kind === "send")!;
  assert.equal(send.status, "dead");
  assert.match(await restarted.send(context(owner), "team", "hello"), /Already sent/);
  assert.equal(textsIn(again, "team").length, 0);
  restarted.kill();
});

test("send: the rights come from the scope, never from the model", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const core = makeCore(freshDb(), connector, echoBrain().brain, { destinations: { team, board } });
  assert.match(await core.send(context(colleague), "board", "x"), /not allowed/);
  assert.match(await core.send(context(colleague), "inès", "x"), /Unknown destination/);
  assert.equal(await core.send(context(colleague), "team", "x"), "Sent.");
  assert.equal(await core.send(context(owner), "inès", "x"), "Sent.");
  assert.equal(textsIn(connector, "dm-inès").length, 1);
  assert.match(await core.send(context(owner), "nobody", "x"), /Nobody named/);
  assert.match(await core.send(context(owner, "team"), "team", "y"), /this conversation/);
  // message:<id>: a private exchange of someone else is out of reach, even for the owner.
  const paul = core.store.ingest(world.say("secret", { thread: "paul-dm", author: "paul", ownerOnly: false }), "fake")!;
  assert.match(await core.send(context(owner), `message:${paul}`, "x"), /No such message/);
  const open = core.store.ingest({ ...world.say("question", { thread: "chan", dm: false, author: "paul", ownerOnly: false }), private: false }, "fake")!;
  assert.equal(await core.send(context(owner), `message:${open}`, "answer"), "Sent.");
  assert.deepEqual(textsIn(connector, "chan"), ["answer"]);
  core.kill();
});

test("jobs: run on their schedule, invisible to the tools; a job gone from the code is dropped", async () => {
  const path = freshDb();
  const store = new Store(openDb(path));
  store.setJob("gone", new Date(Date.now() - 1000).toISOString(), 1);
  let runs = 0;
  const seen: string[] = [];
  const brain: Brain = async ({ tools = [] }) => {
    seen.push(...tools.map((t) => t.name));
    return { messages: ["ok"] };
  };
  const world = new World();
  const core = makeCore(path, new FakeConnector(world), brain, {}, { jobs: { tick: { everyMinutes: 0.001, run: async () => void runs++ } } });
  await core.start();
  await waitFor(() => runs >= 2);
  core.ingest(world.say("hi"), "fake");
  await waitFor(() => seen.length > 0);
  assert.ok(!seen.some((name) => name.includes("tick")));
  assert.equal(openDb(path).prepare("SELECT 1 FROM reminders WHERE job = 'gone'").get(), undefined);
  core.kill();
});

test("github: a signed deployment_status becomes one event in the configured conversation", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const core = makeCore(freshDb(), connector, async ({ prompt }) => ({ messages: [prompt.includes("success") ? "deployed!" : "?"] }));
  await core.start();
  const github = githubSource(core, { secret: "s3cret", port: 0, address: { connector: "fake", conversation: "deploys", thread: "main" } });
  const delivery = (state: string) =>
    JSON.stringify({ repository: { full_name: "acme/api" }, deployment: { id: 42, ref: "main", environment: "production" }, deployment_status: { state, created_at: new Date().toISOString() } });
  const sign = (body: string) => `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;

  assert.equal(github.handle("deployment_status", "sha256=bad", delivery("success")), 401);
  assert.equal(github.handle("deployment_status", sign(delivery("in_progress")), delivery("in_progress")), 202);
  assert.equal(github.handle("deployment_status", sign(delivery("success")), delivery("success")), 202);
  assert.equal(github.handle("deployment_status", sign(delivery("success")), delivery("success")), 202);
  await waitFor(() => textsIn(connector, "deploys").length === 1);
  await sleep(50);
  assert.deepEqual(textsIn(connector, "deploys"), ["deployed!"]);
  assert.equal(core.store.events("fake:deploys").filter((e) => e.kind === "received").length, 1);
  core.kill();
});
