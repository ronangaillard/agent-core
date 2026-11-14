import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareCopy, pushBranch } from "../src/runners/claude-code.ts";
import type { TaskRun, TaskRunner } from "../src/tasks.ts";
import type { Brain, Scope, ToolContext } from "../src/types.ts";
import { echoBrain, FakeConnector, freshDb, makeCore, sleep, waitFor, World } from "./helpers.ts";

const owner: Scope = { owner: true, requester: "ronan", private: true };
const paul: Scope = { owner: false, requester: "paul", private: false };
const ines: Scope = { owner: false, requester: "ines", private: false };
const context = (scope: Scope, thread: string): ToolContext => ({
  scope,
  threadKey: `fake:${thread}`,
  lotIds: [1],
  connector: "fake",
  address: { connector: "fake", conversation: thread, thread: "main" },
});
const textsIn = (connector: FakeConnector, thread: string) => connector.sent.filter((s) => s.address.conversation === thread).map((s) => ("text" in s.post ? s.post.text : ""));
const tasks = { repos: ["acme/api", "acme/web"], taskNoteGapMs: 0 };

/** A runner the test drives: each run waits until released, unless told to finish at once. */
function fakeRunner(auto = true) {
  const runs: TaskRun[] = [];
  const release: (() => void)[] = [];
  const runner: TaskRunner = async (run) => {
    runs.push(run);
    if (!auto) await new Promise<void>((resolve, reject) => {
      release.push(resolve);
      run.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    run.setPr(87);
    return { report: `done: ${run.request}`, status: "waiting" };
  };
  return { runner, runs, release };
}

test("code task: started from a conversation, continued there by default, reported there", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { runner, runs } = fakeRunner();
  const brain: Brain = async ({ prompt, tools = [] }) => {
    if (prompt.includes("CSV")) await tools.find((t) => t.name === "start_code_task")!.run({ request: "add a CSV export", title: "CSV export" });
    return { messages: ["on it"] };
  };
  const core = makeCore(freshDb(), connector, brain, tasks, { runner });
  await core.start();
  core.ingest(world.say("build me a CSV export", { thread: "a", dm: false, mention: true, author: "paul", ownerOnly: false }), "fake");
  await waitFor(() => textsIn(connector, "a").includes("done: add a CSV export"));
  const task = core.store.task(1)!;
  assert.deepEqual([task.status, task.pr, task.repo, task.branch], ["waiting", 87, "acme/api", "agent/1-csv-export"]);
  assert.match(runs[0]!.conversation, /build me a CSV export/);

  assert.match(await core.startTask(context(paul, "a"), { request: "make it XLSX", fresh: false }), /Task #1 continues .*PR #87/);
  await waitFor(() => textsIn(connector, "a").includes("done: make it XLSX"));
  assert.equal(runs[1]!.task.id, 1);
  assert.match(await core.startTask(context(paul, "a"), { request: "something else", fresh: true }), /Task #2 started/);
  assert.match(await core.startTask(context(paul, "a"), { request: "which?", fresh: false }), /Several tasks are open here/);
  assert.match(await core.startTask(context(paul, "a"), { request: "x", fresh: true, repo: "evil/repo" }), /Not a repository/);
  core.kill();
});

test("code task: continued from elsewhere it reports where it was asked; a private task stays out of reach", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { runner } = fakeRunner();
  const core = makeCore(freshDb(), connector, echoBrain().brain, tasks, { runner });
  await core.start();
  await core.startTask(context(paul, "a"), { request: "export", fresh: false });
  await core.startTask(context({ ...paul, private: true }, "paul-dm"), { request: "secret thing", fresh: false });
  await waitFor(() => core.store.task(2)?.status === "waiting");

  assert.match(await core.startTask(context(owner, "owner-dm"), { request: "XLSX instead", task: 1, fresh: false }), /report will come in its conversation \(fake:a\)/);
  await waitFor(() => textsIn(connector, "a").includes("done: XLSX instead"));
  assert.equal(textsIn(connector, "owner-dm").length, 0);
  assert.match(await core.startTask(context(owner, "owner-dm"), { request: "peek", task: 2, fresh: false }), /No task #2/);
  // The rights of a continuation: the lesser of the task's and the requester's.
  assert.equal(core.store.task(1)!.owner_asked, false);
  core.kill();
});

test("code task: a running task is changed only by its requester or the owner; a replaced run says nothing", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { runner, runs, release } = fakeRunner(false);
  const core = makeCore(freshDb(), connector, echoBrain().brain, tasks, { runner });
  await core.start();
  await core.startTask(context(paul, "a"), { request: "first", fresh: false });
  await waitFor(() => runs.length === 1);
  assert.match(await core.startTask(context(ines, "a"), { request: "hijack", fresh: false }), /running for someone else/);
  await core.startTask(context(paul, "a"), { request: "second", fresh: false });
  await waitFor(() => runs.length === 2);
  release[1]!();
  await waitFor(() => textsIn(connector, "a").length === 1);
  await sleep(30);
  assert.deepEqual(textsIn(connector, "a"), ["done: second"]);
  core.kill();
});

test("code task: a restart runs it again, twice at most, then abandons it with a word", async () => {
  const world = new World();
  const path = freshDb();
  const first = fakeRunner(false);
  let core = makeCore(path, new FakeConnector(world), echoBrain().brain, tasks, { runner: first.runner });
  await core.start();
  await core.startTask(context(paul, "a"), { request: "long one", fresh: false });
  await waitFor(() => first.runs.length === 1);
  for (let i = 1; i <= 2; i++) {
    core.kill();
    const again = fakeRunner(false);
    core = makeCore(path, new FakeConnector(world), echoBrain().brain, tasks, { runner: again.runner });
    await core.start();
    await waitFor(() => again.runs.length === 1);
    assert.equal(again.runs[0]!.resumed, true);
    assert.equal(again.runs[0]!.request, "long one");
  }
  core.kill();
  const connector = new FakeConnector(world);
  const last = fakeRunner(false);
  core = makeCore(path, connector, echoBrain().brain, tasks, { runner: last.runner });
  await core.start();
  await waitFor(() => textsIn(connector, "a").some((t) => /cut by restarts/.test(t)));
  assert.equal(last.runs.length, 0);
  assert.equal(core.store.task(1)!.status, "abandoned");
  core.kill();
});

test("code task: progress notes are capped, a failure is reported, and <in_progress> shows what is visible", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const runner: TaskRunner = async (run) => {
    for (let i = 0; i < 7; i++) run.progress(`note ${i}`);
    throw new Error("tests are red");
  };
  const { brain, prompts } = echoBrain();
  const core = makeCore(freshDb(), connector, brain, tasks, { runner });
  await core.start();
  await core.startTask(context(paul, "a"), { request: "fix", title: "fix login", fresh: false });
  await core.startTask(context({ ...paul, private: true }, "paul-dm"), { request: "secret", title: "secret job", fresh: false });
  await waitFor(() => textsIn(connector, "a").some((t) => t.includes("blocked: tests are red")));
  assert.equal(textsIn(connector, "a").filter((t) => t.startsWith("note")).length, 5);
  assert.equal(core.store.task(1)!.status, "done");

  core.ingest(world.say("what's up?", { thread: "chan", dm: false, mention: true, author: "ines", ownerOnly: false }), "fake");
  await waitFor(() => prompts.length === 1);
  assert.match(prompts[0]!, /<in_progress>[\s\S]*task #1 "fix login"/);
  assert.doesNotMatch(prompts[0]!, /secret job/);
  core.kill();
});

test("runner: the copy is cloned on the task's branch, and only that branch is pushed", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-git-"));
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
  const bare = join(root, "origin.git");
  run(root, "init", "--quiet", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  run(root, "clone", "--quiet", bare, seed);
  writeFileSync(join(seed, "README.md"), "hello\n");
  run(seed, "add", ".");
  run(seed, "commit", "--quiet", "-m", "init");
  run(seed, "push", "--quiet", "origin", "HEAD:main");

  const copy = join(root, "task-1");
  await prepareCopy(copy, bare, "agent/1-x", "token");
  assert.equal(run(copy, "rev-parse", "--abbrev-ref", "HEAD"), "agent/1-x");
  writeFileSync(join(copy, "feature.txt"), "x\n");
  run(copy, "add", ".");
  run(copy, "commit", "--quiet", "-m", "feature");
  await pushBranch(copy, "agent/1-x", "token");
  assert.match(run(bare, "branch", "--list"), /agent\/1-x/);
  assert.throws(() => run(copy, "config", "--get", "http.extraheader"), "the token is never written");

  // A copy made again (another machine, a wiped workspace) starts from the pushed branch.
  const again = join(root, "task-1-again");
  await prepareCopy(again, bare, "agent/1-x", "token");
  assert.match(run(again, "log", "--oneline", "-1"), /feature/);
  run(copy, "checkout", "--quiet", "main");
  await assert.rejects(() => pushBranch(copy, "agent/1-x", "token"), /not on the task's branch/);
});
