import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { emailConnector, rejectionOf, subjectKey, svixOk, type Received } from "../src/connectors/email.ts";
import { ownerCommands } from "../src/owner.ts";
import type { Brain } from "../src/types.ts";
import { echoBrain, FakeConnector, freshDb, makeCore, sleep, waitFor, World } from "./helpers.ts";

const textsIn = (connector: FakeConnector, thread: string) => connector.sent.filter((s) => s.address.conversation === thread).map((s) => ("text" in s.post ? s.post.text : ""));
const commands = { commands: ownerCommands() };

test("held: a reply that waits for the owner leaves nothing, is announced to him, and never locks its thread", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  connector.holdWith = "Paul asks for a discount.";
  const core = makeCore(freshDb(), connector, echoBrain().brain, {}, commands);
  await core.start();
  const id = core.ingest(world.say("can we get 20% off?", { thread: "mail", author: "paul", ownerOnly: false }), "fake")!;
  await waitFor(() => textsIn(connector, "owner").length === 1);
  const [notice] = textsIn(connector, "owner");
  assert.match(notice!, new RegExp(`Waiting for you \\(#${id}\\).*Paul asks for a discount`));
  assert.match(notice!, /> reply 1/);
  assert.match(notice!, new RegExp(`send ${id}: <your text> · drop ${id}`));
  assert.equal(textsIn(connector, "mail").length, 0);
  // The thread is free: a second message is answered, and its held reply replaces the first.
  core.ingest(world.say("any news?", { thread: "mail", author: "paul", ownerOnly: false }), "fake");
  await waitFor(() => textsIn(connector, "owner").length === 2);
  assert.deepEqual(
    core.store.held().map((lot) => lot.texts),
    [["reply 2"]],
  );
  core.kill();
});

test("owner commands: answered by code in his private conversation, never for anyone else", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  connector.holdWith = "";
  const { brain, prompts } = echoBrain();
  const core = makeCore(freshDb(), connector, brain, {}, commands);
  await core.start();
  const first = core.ingest(world.say("question one", { thread: "a", author: "paul", ownerOnly: false }), "fake")!;
  const second = core.ingest(world.say("question two", { thread: "b", author: "ines", ownerOnly: false }), "fake")!;
  await waitFor(() => core.store.held().length === 2);
  connector.holdWith = undefined;
  const asked = prompts.length;

  core.ingest(world.say("held", { thread: "owner" }), "fake");
  await waitFor(() => textsIn(connector, "owner").some((t) => t.startsWith(`#${first}`)));
  core.ingest(world.say(`send ${first}`, { thread: "owner" }), "fake");
  await waitFor(() => textsIn(connector, "a").length === 1);
  core.ingest(world.say(`send ${second}: Not this month, sorry.`, { thread: "owner" }), "fake");
  await waitFor(() => textsIn(connector, "b").length === 1);
  assert.deepEqual(textsIn(connector, "b"), ["Not this month, sorry."]);
  core.ingest(world.say(`drop ${second}`, { thread: "owner" }), "fake");
  await waitFor(() => textsIn(connector, "owner").includes(`Nothing waits as #${second}.`));
  assert.equal(prompts.length, asked, "no command reached the model");
  assert.ok(core.store.events("fake:owner").some((e) => e.kind === "intercepted"));

  // Paul typing the same words is just a message.
  core.ingest(world.say(`send ${first}`, { thread: "c", author: "paul", ownerOnly: false }), "fake");
  await waitFor(() => prompts.length === asked + 1);
  core.kill();
});

test("draft for the owner: a mention of him becomes his reply, held, acting on nothing, posted in his name once approved", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const seen: string[][] = [];
  const brain: Brain = async ({ prompt, tools = [] }) => {
    seen.push(tools.map((t) => t.name));
    return { messages: [prompt.includes("Write the reply ronan would send") ? "Yes, tomorrow at 10." : "?"] };
  };
  const core = makeCore(freshDb(), connector, brain, { draftForOwner: true, ownerName: "ronan" }, commands);
  await core.start();
  const id = core.ingest(world.say("@ronan can we meet tomorrow?", { thread: "chan", dm: false, author: "paul", ownerOnly: false, mentionsOwner: true }), "fake")!;
  await waitFor(() => textsIn(connector, "owner").length === 1);
  assert.match(textsIn(connector, "owner")[0]!, /paul mentioned you test: "@ronan can we meet tomorrow\?"/);
  assert.ok(!seen[0]!.includes("send") && !seen[0]!.includes("set_reminder"));
  assert.equal(textsIn(connector, "chan").length, 0);

  core.ingest(world.say(`send ${id}`, { thread: "owner" }), "fake");
  await waitFor(() => textsIn(connector, "chan").length === 1);
  const posted = connector.sent.find((s) => s.address.conversation === "chan")!;
  assert.deepEqual(posted.post, { text: "Yes, tomorrow at 10.", as: "owner" });
  assert.equal(core.store.agentSpokeIn("fake:chan"), false);
  // Without the option, the same mention is ignored.
  const quiet = makeCore(freshDb(), new FakeConnector(world), brain, {}, commands);
  await quiet.start();
  quiet.ingest(world.say("@ronan ping", { thread: "chan2", dm: false, author: "paul", ownerOnly: false, mentionsOwner: true }), "fake");
  await waitFor(() => quiet.store.events("fake:chan2").some((e) => e.kind === "ignored"));
  core.kill();
  quiet.kill();
});

const options = {
  apiKey: "re_test",
  webhookSecret: `whsec_${Buffer.from("secret-key").toString("base64")}`,
  port: 0,
  address: "agent@acme.fr",
  name: "Agent",
  allowedDomains: ["acme.fr"],
  ownerEmails: ["ronan@acme.fr"],
  ownerId: "U_RONAN",
};

const mail = (over: Partial<Received> = {}): Received => ({
  id: "r1",
  from: "Paul Martin <paul@acme.fr>",
  to: ["agent@acme.fr"],
  subject: "Re: Budget 2027",
  text: "Hi,\nwhat about the budget?",
  created_at: new Date().toISOString(),
  message_id: "<m1@acme.fr>",
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  ...over,
});

test("e-mail: Svix signature, who is read, a thread per started mail and sender, never the owner's scope", async () => {
  const body = '{"type":"email.received","data":{"email_id":"r1"}}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1,${createHmac("sha256", Buffer.from("secret-key")).update(`msg_1.${timestamp}.${body}`).digest("base64")}`;
  assert.equal(svixOk(options.webhookSecret, { id: "msg_1", timestamp, signature }, body), true);
  assert.equal(svixOk(options.webhookSecret, { id: "msg_1", timestamp, signature }, `${body} `), false);
  assert.equal(svixOk(options.webhookSecret, { id: "msg_1", timestamp, signature }, body, Date.now() + 600_000), false);

  assert.equal(rejectionOf(mail(), options), undefined);
  assert.match(rejectionOf(mail({ from: "x@evil.com" }), options)!, /domains/);
  assert.match(rejectionOf(mail({ authentication: { dmarc: "fail" } }), options)!, /DMARC/);
  assert.match(rejectionOf(mail({ from: "agent@acme.fr" }), options)!, /itself/);
  assert.equal(subjectKey("RE: Fwd: Budget 2027"), "budget 2027");

  const connector = emailConnector(options);
  const paul = (await connector.toInbox(mail()))!;
  assert.equal(paul.thread_key, "email:m1@acme.fr paul@acme.fr");
  assert.equal(paul.author_id, "paul@acme.fr");
  assert.equal(paul.owner_only, false);
  // The thread is the mail that started it, not the subject: same subject from someone else, another conversation.
  const reply = (await connector.toInbox(mail({ id: "r2", message_id: "<m2@acme.fr>", headers: { References: "<m1@acme.fr> <x@acme.fr>" } })))!;
  assert.equal(reply.thread_key, "email:m1@acme.fr paul@acme.fr");
  const other = (await connector.toInbox(mail({ id: "r3", from: "ines@acme.fr", message_id: "<m3@acme.fr>" })))!;
  assert.notEqual(other.thread_key, paul.thread_key);
  // Ines knows the first Message-ID (she was in copy): she still does not join Paul's conversation.
  const joined = (await connector.toInbox(mail({ id: "r4", from: "ines@acme.fr", message_id: "<m4@acme.fr>", headers: { References: "<m1@acme.fr>" } })))!;
  assert.notEqual(joined.thread_key, paul.thread_key);
  // A Reply-To outside the allowed domains is not followed.
  assert.equal((await connector.toInbox(mail({ reply_to: ["drop@evil.com"] })))!.address.conversation, "paul@acme.fr");
  assert.match(rejectionOf(mail({ from: "x@acme.fr@evil.com" }), options)!, /domains/);
  const alone = (await connector.toInbox(mail({ from: "ronan@acme.fr", text: "send 12" })))!;
  assert.equal(alone.author_id, "U_RONAN");
  // DMARC vouches for a domain, not a mailbox: no owner scope, no command by e-mail.
  assert.equal(alone.owner_only, false);
  assert.equal(alone.text, undefined);
  assert.equal(await connector.toInbox(mail({ authentication: null })), null);

  assert.deepEqual(connector.form.toPosts({ body: "Hello", sure: false, summary: "Budget.", reason: "Commits you." }), { posts: [{ text: "Hello" }], held: true, note: "Budget. Commits you." });
  assert.deepEqual(connector.form.toPosts({ body: " ", sure: true, summary: "", reason: "" }).posts, []);
  await sleep(0);
});
