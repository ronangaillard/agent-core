import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { digest } from "../src/history.ts";
import { ownerCommands } from "../src/owner.ts";
import { Store } from "../src/store.ts";
import type { Address, Brain, DeliverResult, Post, Scope } from "../src/types.ts";
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
  assert.doesNotMatch(digest(core.store, "fake:elsewhere", colleague, "ronan"), /40k/);
  assert.match(digest(core.store, "fake:elsewhere", { owner: true, requester: "ronan", private: true }, "ronan"), /40k/);
  core.kill();
});
