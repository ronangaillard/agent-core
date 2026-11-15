import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apercuWorkshop, type OpenWorkshop } from "../src/runners/apercu.ts";
import { claudeCodeRunner, fit, gitIdentity, readSession, SESSION_COMMAND, tokenFor, tokensFromEnv } from "../src/runners/claude-code.ts";
import type { TaskRecord } from "../src/store.ts";

type Call = { method: string; path: string; auth?: string; body: Record<string, unknown> };

/** steve-apercu's workshop API, faked: one workshop per copy, mounted under /data/workspace; a session streams lines. */
async function fakeApercu(mount = "/data/workspace", lines: string[] = ["one", "two"], exit: number | null = 0) {
  const calls: Call[] = [];
  const open = new Set<string>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ method: req.method ?? "", path: req.url ?? "", body, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    const reply = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (req.headers.authorization !== "Bearer secret") return reply(401, { erreur: "jeton" });
    const parts = (req.url ?? "").split("/").filter(Boolean);
    if (req.method === "POST" && parts.length === 1 && parts[0] === "ateliers") {
      const copie = String(body.copie);
      open.add(copie);
      return reply(200, { id: copie, copie, dossier: `${mount}/${copie}` });
    }
    if (req.method === "POST" && parts.length === 3 && parts[2] === "session") {
      if (!open.has(parts[1]!)) return reply(404, { erreur: `introuvable : « ${parts[1]} »` });
      res.writeHead(200, { "content-type": "text/plain" });
      for (const line of lines) res.write(`${line}\n`);
      return res.end(exit === null ? "" : `__exit__ ${exit}\n`);
    }
    if (req.method === "DELETE" && parts.length === 2) {
      open.delete(parts[1]!);
      return reply(200, { id: parts[1], etat: "ferme" });
    }
    reply(404, { erreur: "inconnu" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, open, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const collect = async (lines: AsyncGenerator<string, number>) => {
  const seen: string[] = [];
  let step = await lines.next();
  while (!step.done) seen.push(step.value), (step = await lines.next());
  return { seen, code: step.value };
};

test("the workshop opens the copy's container, streams a session's lines and its exit code, and closes", async () => {
  const apercu = await fakeApercu();
  try {
    const workshop = await apercuWorkshop({ url: apercu.url, token: "secret" })("/data/workspace/task-7");
    assert.deepEqual(apercu.calls[0], { method: "POST", path: "/ateliers", auth: "Bearer secret", body: { copie: "task-7" } });
    // A fresh container each run: the one found is closed and opened again.
    assert.deepEqual(apercu.calls.slice(1, 3).map((c) => `${c.method} ${c.path}`), ["DELETE /ateliers/task-7", "POST /ateliers"]);
    assert.deepEqual(await collect(workshop.session("claude -p", { GH_TOKEN: "t" }, new AbortController().signal)), { seen: ["one", "two"], code: 0 });
    assert.deepEqual(apercu.calls[3]?.body, { commande: "claude -p", env: { GH_TOKEN: "t" } });
    await workshop.close();
    assert.equal(apercu.open.size, 0);
    assert.deepEqual([apercu.calls.at(-1)?.method, apercu.calls.at(-1)?.path], ["DELETE", "/ateliers/task-7"]);
  } finally {
    await apercu.close();
  }
});

test("a session cut before its end is a failure, not a success", async () => {
  const apercu = await fakeApercu("/data/workspace", ["half"], null);
  try {
    const workshop = await apercuWorkshop({ url: apercu.url, token: "secret" })("/data/workspace/task-2");
    await assert.rejects(collect(workshop.session("x", {}, new AbortController().signal)), /cut before its end/);
  } finally {
    await apercu.close();
  }
});

test("a copy mounted at another path than the agent's is refused", async () => {
  const apercu = await fakeApercu("/elsewhere");
  try {
    await assert.rejects(apercuWorkshop({ url: apercu.url, token: "secret" })("/data/workspace/task-9"), /must match/);
    assert.equal(apercu.open.size, 0, "the mismatched workshop is closed");
  } finally {
    await apercu.close();
  }
});

test("errors of the service surface with its message", async () => {
  const apercu = await fakeApercu();
  try {
    await assert.rejects(apercuWorkshop({ url: apercu.url, token: "wrong" })("/data/workspace/task-1"), /401 jeton/);
  } finally {
    await apercu.close();
  }
});

async function* stream(lines: unknown[], code = 0): AsyncGenerator<string, number> {
  for (const line of lines) yield typeof line === "string" ? line : JSON.stringify(line);
  return code;
}
const todos = (...items: [string, string][]) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: items.map(([content, status]) => ({ content, activeForm: `${content}…`, status })) } }] },
});

test("the session's news is its todo item in progress, once each; its end is its structured report", async () => {
  const news: string[] = [];
  const result = await readSession(
    stream([
      { type: "system", subtype: "init" },
      todos(["Read the code", "in_progress"], ["Open the PR", "pending"]),
      todos(["Read the code", "in_progress"], ["Open the PR", "pending"]),
      "some shell noise",
      todos(["Read the code", "completed"], ["Open the PR", "in_progress"]),
      { type: "result", subtype: "success", is_error: false, result: "", structured_output: { report: "PR #12 opened" } },
    ]),
    (text) => news.push(text),
  );
  assert.deepEqual(news, ["Read the code…", "Open the PR…"]);
  assert.deepEqual(result, { report: "PR #12 opened" });
});

test("headless, the news comes from the task tools: TaskCreate numbers them, TaskUpdate in_progress says one", async () => {
  const news: string[] = [];
  const create = (subject: string, activeForm: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "TaskCreate", input: { subject, description: "", activeForm } }] } });
  const update = (taskId: string, status: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "TaskUpdate", input: { taskId, status } }] } });
  await readSession(
    stream([create("Run the checks", "Running the checks"), create("Open the PR", "Opening the PR"), update("1", "in_progress"), update("1", "completed"), update("2", "in_progress"), { type: "result", subtype: "success", structured_output: { report: "ok" } }]),
    (text) => news.push(text),
  );
  assert.deepEqual(news, ["Running the checks", "Opening the PR"]);
});

test("the conversation is cut to its end in bytes, on a character boundary", () => {
  assert.equal(fit("short", 100), "short");
  const cut = fit("é".repeat(100), 50);
  assert.ok(Buffer.byteLength(cut) <= 50 + 10, cut);
  assert.match(cut, /^…\(cut\)\né+$/);
});

test("a session without a result, or a failed one, is an error that says why", async () => {
  await assert.rejects(readSession(stream(["claude: command not found"], 127), () => undefined), /without a result \(exit 127\): claude: command not found/);
  await assert.rejects(readSession(stream([{ type: "result", subtype: "error_max_turns", is_error: true }], 1), () => undefined), /failed \(error_max_turns\)/);
});

test("the session command: the repository's settings, none of its MCP servers, no web, no prompts; input by the environment", () => {
  for (const part of ['git remote set-url origin "$AGENT_REMOTE"', "--setting-sources project", "--strict-mcp-config", "--disallowedTools WebSearch WebFetch", "--dangerously-skip-permissions", '"$AGENT_PROMPT"', '"$AGENT_SYSTEM"', '"$AGENT_SCHEMA"', '"$AGENT_MODEL"'])
    assert.ok(SESSION_COMMAND.includes(part), part);
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("runner: the session runs in the workshop with the task's token and its origin; the PR it opened is found after", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-"));
  const bare = join(root, "remote", "acme", "app.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "--quiet", bare, seed]);
  git(seed, "commit", "--quiet", "--allow-empty", "-m", "first");
  git(seed, "push", "--quiet", "origin", "HEAD:main");

  const api = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer acme-token");
    assert.equal(req.url, `/repos/acme/app/pulls?head=${encodeURIComponent("acme:agent/5-x")}&state=all&per_page=1`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ number: 42 }]));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));

  let sent: { command: string; env: Record<string, string>; dir: string } | undefined;
  let closed = 0;
  let failing = false;
  const workshop: OpenWorkshop = async (dir) => ({
    session(command, env) {
      sent = { command, env, dir };
      if (failing) return stream([{ type: "result", subtype: "error_max_turns", is_error: true }], 1);
      return stream([todos(["Push", "in_progress"]), { type: "result", subtype: "success", structured_output: { report: "done, PR #42" } }]);
    },
    async close() {
      closed++;
    },
  });
  const news: string[] = [];
  let pr: number | undefined;
  try {
    const runner = claudeCodeRunner({
      workspace: join(root, "workspace"),
      githubToken: "default",
      githubTokens: { acme: "acme-token" },
      persona: "You are Steve.",
      name: "Steve",
      model: "opus",
      workshop,
      claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: "claude-token" },
      gitBase: join(root, "remote"),
      githubApi: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    });
    const task = { id: 5, title: "x", repo: "acme/app", branch: "agent/5-x", pr: null } as unknown as TaskRecord;
    const outcome = await runner({
      task,
      request: "Change the title",
      conversation: "ronan: please",
      resumed: false,
      signal: new AbortController().signal,
      progress: (text) => news.push(text),
      setPr: (n) => (pr = n),
    });
    assert.deepEqual(outcome, { report: "done, PR #42", status: "waiting" });
    assert.equal(pr, 42);
    assert.deepEqual(news, ["Push…"]);
    assert.equal(closed, 1, "the workshop is closed with the run");
    assert.equal(sent?.dir, join(root, "workspace", "task-5"));
    assert.equal(sent?.command, SESSION_COMMAND);
    assert.equal(sent?.env.GH_TOKEN, "acme-token", "the task's repository owner's token");
    assert.equal(sent?.env.CLAUDE_CODE_OAUTH_TOKEN, "claude-token");
    assert.equal(sent?.env.AGENT_MODEL, "opus");
    assert.match(sent?.env.AGENT_PROMPT ?? "", /<request>\nChange the title\n<\/request>/);
    assert.match(sent?.env.AGENT_SYSTEM ?? "", /^You are Steve\.\n\n.*on branch agent\/5-x/s);
    assert.equal(sent?.env.GIT_AUTHOR_NAME, "Steve");
    assert.equal(sent?.env.AGENT_REMOTE, bare, "the session sets its origin to the remote, in its container");
    assert.equal(sent?.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
    const copy = join(root, "workspace", "task-5");
    assert.equal(git(copy, "rev-parse", "--abbrev-ref", "HEAD"), "agent/5-x");

    // A session that opened its PR then failed: the PR is still noted, the failure reported.
    failing = true;
    pr = undefined;
    await assert.rejects(
      runner({ task, request: "again", conversation: "", resumed: false, signal: new AbortController().signal, progress: () => undefined, setPr: (n) => (pr = n) }),
      /error_max_turns/,
    );
    assert.equal(pr, 42);
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

test("the commits' author: the agent, with a noreply address", () => {
  assert.deepEqual(gitIdentity("O'Brien"), {
    GIT_AUTHOR_NAME: "O'Brien",
    GIT_COMMITTER_NAME: "O'Brien",
    GIT_AUTHOR_EMAIL: "o-brien@users.noreply.github.com",
    GIT_COMMITTER_EMAIL: "o-brien@users.noreply.github.com",
  });
});

test("each repository gets its owner's token, else the default one", () => {
  const byOwner = tokensFromEnv({ GITHUB_TOKEN: "default", GITHUB_TOKEN_RONAN: "perso", GITHUB_TOKEN_ACME_LABS: "acme", GITHUB_TOKEN_EMPTY: "", OTHER: "x" });
  assert.deepEqual(byOwner, { ronan: "perso", "acme-labs": "acme" });
  assert.equal(tokenFor("ronan/agent-core", "default", byOwner), "perso");
  assert.equal(tokenFor("Ronan/agent-core", "default", byOwner), "perso", "GitHub owners ignore case");
  assert.equal(tokenFor("acme-labs/api", "default", byOwner), "acme");
  assert.equal(tokenFor("maestro-tech/still-maestro", "default", byOwner), "default");
  assert.equal(tokenFor("ronanx/repo", "default", byOwner), "default", "a prefix is not the owner");
});
