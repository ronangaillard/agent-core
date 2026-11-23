import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareCopy } from "../src/runners/claude-code.ts";
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
const tasks = { repos: ["acme/api"] };
const twoRepos = { repos: ["acme/api", "acme/web"] };

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

test("code task: continued from elsewhere it reports to whoever asked, not to its own conversation; a private task stays out of reach", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { runner } = fakeRunner();
  const core = makeCore(freshDb(), connector, echoBrain().brain, tasks, { runner });
  await core.start();
  await core.startTask(context(paul, "a"), { request: "export", fresh: false });
  await core.startTask(context({ ...paul, private: true }, "paul-dm"), { request: "secret thing", fresh: false });
  await waitFor(() => core.store.task(2)?.status === "waiting");

  assert.match(await core.startTask(context(owner, "owner-dm"), { request: "XLSX instead", task: 1, fresh: false }), /report will come in this conversation, not in the task's own \(fake:a\)/);
  await waitFor(() => textsIn(connector, "owner-dm").includes("done: XLSX instead"));
  assert.deepEqual(textsIn(connector, "a"), ["done: export"], "its own conversation is not told of what another asked");
  // Asked again in its own conversation: reported there again.
  assert.match(await core.startTask(context(paul, "a"), { request: "CSV after all", fresh: false }), /report will come in this conversation\./);
  await waitFor(() => textsIn(connector, "a").includes("done: CSV after all"));
  assert.deepEqual(textsIn(connector, "owner-dm"), ["done: XLSX instead"]);
  assert.match(await core.startTask(context(owner, "owner-dm"), { request: "peek", task: 2, fresh: false }), /No task #2/);
  // The rights of a continuation: the lesser of the task's and the requester's.
  assert.equal(core.store.task(1)!.owner_asked, false);
  core.kill();
});

test("code task: changed by its requester, the owner or in its own conversation, not taken over from elsewhere; a replaced run says nothing", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { runner, runs, release } = fakeRunner(false);
  const core = makeCore(freshDb(), connector, echoBrain().brain, tasks, { runner });
  await core.start();
  await core.startTask(context(paul, "a"), { request: "first", fresh: false });
  await waitFor(() => runs.length === 1);
  assert.match(await core.startTask(context(ines, "b"), { request: "hijack", task: 1, fresh: false }), /asked by someone else/);
  await core.startTask(context(paul, "a"), { request: "second", fresh: false });
  await waitFor(() => runs.length === 2);
  release[1]!();
  await waitFor(() => textsIn(connector, "a").length === 1);
  await sleep(30);
  assert.deepEqual(textsIn(connector, "a"), ["done: second"]);
  core.kill();
});

test("code task: a restart runs it again, twice at most, then fails it with a word, and asking again resumes it", async () => {
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
  assert.equal(core.store.task(1)!.status, "failed");
  assert.match(await core.startTask(context(paul, "a"), { request: "go on", fresh: false }), /Task #1 continues/);
  await waitFor(() => last.runs.length === 1);
  core.kill();
});

test("code task: nothing is posted along the way, the step is said when asked; a failure is reported; <in_progress> shows what is visible", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  let finish!: () => void;
  const runner: TaskRunner = async (run) => {
    for (let i = 0; i < 7; i++) run.progress(`note ${i}`);
    await new Promise<void>((resolve) => (finish = resolve));
    throw new Error("tests are red");
  };
  const { brain, prompts } = echoBrain();
  const core = makeCore(freshDb(), connector, brain, tasks, { runner });
  await core.start();
  await core.startTask(context(paul, "a"), { request: "fix", title: "fix login", fresh: false });
  await core.startTask(context({ ...paul, private: true }, "paul-dm"), { request: "secret", title: "secret job", fresh: false });
  await waitFor(() => Boolean(finish));

  core.ingest(world.say("what's up?", { thread: "chan", dm: false, mention: true, author: "ines", ownerOnly: false }), "fake");
  await waitFor(() => prompts.length === 1);
  assert.match(prompts[0]!, /<in_progress>[\s\S]*task #1 "fix login"[^\n]*\(now: note 6\)/);
  assert.doesNotMatch(prompts[0]!, /secret job/);
  assert.equal(textsIn(connector, "a").filter((t) => t.includes("note")).length, 0, "no progress note posted");

  finish();
  await waitFor(() => textsIn(connector, "a").some((t) => t.includes("failed: tests are red")));
  assert.equal(core.store.task(1)!.status, "failed", "a failure is not done: the task stays open");
  core.kill();
});

test("code task: with several repositories, a new task names one; with one, it is the default", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { runner, runs } = fakeRunner();
  const core = makeCore(freshDb(), connector, echoBrain().brain, twoRepos, { runner });
  await core.start();
  assert.match(await core.startTask(context(paul, "a"), { request: "fix it", fresh: false }), /Which repository\? .*acme\/api, acme\/web\. Nothing was started/);
  assert.equal(core.store.task(1), undefined);
  assert.match(await core.startTask(context(paul, "a"), { request: "fix it", fresh: false, repo: "acme/web" }), /Task #1 started on acme\/web/);
  await waitFor(() => core.store.task(1)?.status === "waiting");
  // Continuing an open task needs no repository.
  assert.match(await core.startTask(context(paul, "a"), { request: "more", fresh: false }), /Task #1 continues/);
  await waitFor(() => runs.length === 2);
  core.kill();
});

test("code task: abandoned by its requester, the owner or its conversation; its run is cut and says nothing more", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const { runner, runs } = fakeRunner(false);
  const core = makeCore(freshDb(), connector, echoBrain().brain, tasks, { runner });
  await core.start();
  await core.startTask(context(paul, "a"), { request: "long", fresh: false });
  await waitFor(() => runs.length === 1);
  assert.match(await core.abandonTask(context(ines, "b"), { task: 1 }), /asked by someone else/);
  assert.match(await core.abandonTask(context(paul, "b"), {}), /No open task here/);
  assert.match(await core.abandonTask(context(paul, "a"), {}), /Task #1 abandoned/);
  assert.equal(runs[0]!.signal.aborted, true, "the run is cut (the runner closes its terminal)");
  await waitFor(() => textsIn(connector, "a").includes("Task #1 abandoned."));
  await sleep(30);
  assert.deepEqual(textsIn(connector, "a"), ["Task #1 abandoned."]);
  assert.equal(core.store.task(1)!.status, "abandoned");
  assert.match(await core.abandonTask(context(owner, "owner-dm"), { task: 1 }), /already abandoned/);
  assert.match(await core.startTask(context(paul, "a"), { request: "again", task: 1, fresh: false }), /No task #1/);
  assert.match(await core.startTask(context(paul, "a"), { request: "new one", fresh: false }), /Task #2 started/);
  core.kill();
});

test("runner: the copy is cloned on the task's branch, without a token; nothing in the copy runs here", async () => {
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
  const vault = join(root, "vault", "task-1.git");
  await prepareCopy(copy, vault, bare, "agent/1-x", "token");
  assert.equal(run(copy, "rev-parse", "--abbrev-ref", "HEAD"), "agent/1-x");
  assert.throws(() => run(copy, "config", "--get", "http.extraheader"), "the token is never written");
  writeFileSync(join(copy, "feature.txt"), "x\n");
  run(copy, "add", ".");
  run(copy, "commit", "--quiet", "-m", "feature");

  // A hostile copy: hooks and an fsmonitor that would run if this process ran git there.
  const marker = join(root, "hook-ran");
  writeFileSync(join(copy, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  writeFileSync(join(copy, ".git", "hooks", "upload-pack"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  run(copy, "config", "core.fsmonitor", `touch ${marker}`);
  await prepareCopy(copy, vault, bare, "agent/1-x", "token");
  assert.match(run(vault, "log", "--oneline", "-1", "agent/1-x"), /feature/, "the vault follows the copy's branch");
  assert.equal(existsSync(marker), false, "no code of the copy ran");

  // The session pushed (its origin set to the remote, in its container); a copy made again starts from that branch.
  run(copy, "-c", "core.fsmonitor=false", "push", "--quiet", bare, "agent/1-x");
  const again = join(root, "task-1-again");
  await prepareCopy(again, join(root, "vault", "again.git"), bare, "agent/1-x", "token");
  assert.match(run(again, "log", "--oneline", "-1"), /feature/);
});

test("runner: a branch without commits of its own restarts from the remote's main as it is now; one with commits stays", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-git-"));
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
  const bare = join(root, "origin.git");
  run(root, "init", "--quiet", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  run(root, "clone", "--quiet", bare, seed);
  const commit = (name: string) => {
    writeFileSync(join(seed, name), `${name}\n`);
    run(seed, "add", ".");
    run(seed, "commit", "--quiet", "-m", name);
    run(seed, "push", "--quiet", "origin", "HEAD:main");
  };
  commit("old");
  const copy = join(root, "task-1");
  const vault = join(root, "vault", "task-1.git");
  await prepareCopy(copy, vault, bare, "agent/1-x", "token");
  writeFileSync(join(copy, "leftover.txt"), "uncommitted\n");
  commit("new");

  // A run asked again: nothing of its own, so it starts from the new main.
  await prepareCopy(copy, vault, bare, "agent/1-x", "token", { restartEmpty: true });
  assert.equal(run(copy, "rev-parse", "--abbrev-ref", "HEAD"), "agent/1-x");
  assert.match(run(copy, "log", "--oneline", "-1"), /new/);
  assert.equal(existsSync(join(copy, "leftover.txt")), false);

  // With a commit of its own, the branch stays as it is.
  writeFileSync(join(copy, "mine.txt"), "x\n");
  run(copy, "add", ".");
  run(copy, "commit", "--quiet", "-m", "mine");
  commit("newer");
  await prepareCopy(copy, vault, bare, "agent/1-x", "token", { restartEmpty: true });
  assert.match(run(copy, "log", "--oneline", "-1"), /mine/);
  assert.equal(existsSync(join(copy, "mine.txt")), true);

  // A run a restart cut keeps its copy, empty or not.
  const other = join(root, "task-2");
  const otherVault = join(root, "vault", "task-2.git");
  await prepareCopy(other, otherVault, bare, "agent/2-y", "token");
  writeFileSync(join(other, "wip.txt"), "in progress\n");
  commit("newest");
  await prepareCopy(other, otherVault, bare, "agent/2-y", "token");
  assert.equal(existsSync(join(other, "wip.txt")), true);
});

test("code task: once done or abandoned, the runner forgets it (its copy goes), after its run; waiting keeps it", async () => {
  const world = new World();
  const connector = new FakeConnector(world);
  const forgotten: number[] = [];
  const outcomes: ("waiting" | "done")[] = ["done", "waiting", "waiting"];
  const runner: TaskRunner = Object.assign(async (run: TaskRun) => {
    if (outcomes[run.task.id - 1] === "waiting") run.setPr(80 + run.task.id);
    return { report: `report ${run.task.id}`, status: outcomes[run.task.id - 1]! };
  }, { forget: (id: number) => void forgotten.push(id) });
  const { brain } = echoBrain();
  const core = makeCore(freshDb(), connector, brain, tasks, { runner });
  await core.start();
  await core.startTask(context(paul, "a"), { request: "one", title: "done", fresh: true });
  await core.startTask(context(paul, "b"), { request: "two", title: "merged", fresh: true });
  await core.startTask(context(paul, "c"), { request: "three", title: "dropped", fresh: true });
  await waitFor(() => core.store.task(3)?.status === "waiting");
  await waitFor(() => forgotten.length === 1);
  assert.deepEqual(forgotten, [1], "done forgets; waiting keeps its copy");
  core.pullRequestClosed("acme/api", 82, true);
  assert.match(await core.abandonTask(context(paul, "c"), {}), /abandoned/);
  await waitFor(() => forgotten.length === 3);
  assert.deepEqual(forgotten, [1, 2, 3]);
  core.kill();
});
