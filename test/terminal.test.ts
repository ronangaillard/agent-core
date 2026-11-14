import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { apercuTerminal } from "../src/runners/apercu.ts";
import { gitIdentity, terminalTool, tokenFor, tokensFromEnv, type Terminal } from "../src/runners/claude-code.ts";

type Call = { method: string; path: string; auth?: string; body: Record<string, unknown> };

/** steve-apercu's workshop API, faked: one workshop per copy, mounted under /data/workspace. */
async function fakeApercu(mount = "/data/workspace") {
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
    if (req.method === "POST" && parts.length === 3 && parts[2] === "exec") {
      if (!open.has(parts[1]!)) return reply(404, { erreur: `introuvable : « ${parts[1]} »` });
      return reply(200, { code: body.commande === "false" ? 1 : 0, sortie: `ran ${String(body.commande)} in ${parts[1]}` });
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

test("the workshop terminal opens the copy's container, runs commands there, and closes it", async () => {
  const apercu = await fakeApercu();
  try {
    const terminal = await apercuTerminal({ url: apercu.url, token: "secret" })("/data/workspace/task-7");
    assert.deepEqual(apercu.calls[0], { method: "POST", path: "/ateliers", auth: "Bearer secret", body: { copie: "task-7" } });
    assert.deepEqual(await terminal.run("npm test", 300), { code: 0, output: "ran npm test in task-7" });
    assert.deepEqual(apercu.calls[1]?.body, { commande: "npm test", delai: 300 });
    assert.equal((await terminal.run("false", 5)).code, 1);
    await terminal.close();
    assert.equal(apercu.open.size, 0);
    assert.equal(apercu.calls.at(-1)?.method, "DELETE");
    assert.equal(apercu.calls.at(-1)?.path, "/ateliers/task-7");
  } finally {
    await apercu.close();
  }
});

test("a workshop closed meanwhile is opened again, once", async () => {
  const apercu = await fakeApercu();
  try {
    const terminal = await apercuTerminal({ url: apercu.url, token: "secret" })("/data/workspace/task-8");
    apercu.open.clear(); // the service restarted
    assert.equal((await terminal.run("ls", 60)).output, "ran ls in task-8");
    assert.equal(apercu.calls.filter((c) => c.method === "POST" && c.path === "/ateliers").length, 2);
  } finally {
    await apercu.close();
  }
});

test("a copy mounted at another path than the agent's is refused (file tools and terminal would disagree)", async () => {
  const apercu = await fakeApercu("/elsewhere");
  try {
    await assert.rejects(apercuTerminal({ url: apercu.url, token: "secret" })("/data/workspace/task-9"), /must match/);
    assert.equal(apercu.open.size, 0, "the mismatched workshop is closed");
  } finally {
    await apercu.close();
  }
});

test("errors of the service surface with its message", async () => {
  const apercu = await fakeApercu();
  try {
    await assert.rejects(apercuTerminal({ url: apercu.url, token: "wrong" })("/data/workspace/task-1"), /401 jeton/);
  } finally {
    await apercu.close();
  }
});

test("the terminal tool opens the terminal lazily and reports exit code and output, or the failure", async () => {
  const commands: string[] = [];
  let opens = 0;
  const terminal: Terminal = {
    run: async (command, timeout) => {
      commands.push(`${command}@${timeout}`);
      return { code: command === "boom" ? 2 : 0, output: command === "quiet" ? "" : "out" };
    },
    close: async () => undefined,
  };
  const tool = terminalTool(async () => {
    opens++;
    return terminal;
  });
  assert.equal(tool.name, "terminal");
  assert.equal(opens, 0);
  const text = async (args: { command: string; timeout_seconds: number }) => {
    const result = await tool.handler(args, {});
    const first = result.content[0];
    return { text: first && first.type === "text" ? first.text : "", error: Boolean(result.isError) };
  };
  assert.deepEqual(await text({ command: "boom", timeout_seconds: 30 }), { text: "exit code 2\nout", error: false });
  assert.deepEqual(await text({ command: "quiet", timeout_seconds: 600 }), { text: "exit code 0\n(no output)", error: false });
  assert.deepEqual(commands, ["boom@30", "quiet@600"]);
  const failing = terminalTool(async () => {
    throw new Error("no workshop");
  });
  const result = await failing.handler({ command: "ls", timeout_seconds: 60 }, {});
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /The terminal failed: no workshop/);
});

test("the terminal tool exports the git identity before each command, quoted for bash", async () => {
  const seen: string[] = [];
  const tool = terminalTool(async () => ({ run: async (command) => (seen.push(command), { code: 0, output: "" }), close: async () => undefined }), gitIdentity("O'Brien"));
  await tool.handler({ command: "git commit -m x", timeout_seconds: 60 }, {});
  const script = seen[0]!;
  assert.ok(script.endsWith("\ngit commit -m x"));
  const out = execFileSync("bash", ["-c", `${script.replace("git commit -m x", 'printf "%s|%s" "$GIT_AUTHOR_NAME" "$GIT_COMMITTER_EMAIL"')}`], { encoding: "utf8" });
  assert.equal(out, "O'Brien|o-brien@users.noreply.github.com");
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
