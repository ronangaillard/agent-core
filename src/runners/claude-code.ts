import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createSdkMcpServer, query, tool, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { jsonSchema } from "../claude.ts";
import type { TaskOutcome, TaskRun, TaskRunner } from "../tasks.ts";

const exec = promisify(execFile);

/** A terminal in another container, opened for one copy: every command of the task runs there. */
export type Terminal = {
  run(command: string, timeoutSeconds: number): Promise<{ code: number; output: string }>;
  close(): Promise<void>;
};
/** Opens the terminal of a copy (an absolute path, which must be the same path inside the remote container). */
export type RemoteTerminal = (dir: string) => Promise<Terminal>;

export type ClaudeCodeOptions = {
  /** Where the copies live, one per task. The session writes nowhere else. */
  workspace: string;
  /** This process's own bare repositories, one per task: the session can neither write nor read them. */
  vault?: string;
  /** More paths the session's terminal must not read (the agent's own folder and home are always denied). */
  denyRead?: string[];
  /** Used by this process only (clone, push, PR): never in the copy, never in the session's environment. */
  githubToken: string;
  /** The agent, as the session's system prompt starts. */
  persona: string;
  name: string;
  model?: string;
  executable?: string;
  /** Default: github.com. Tests point it to local bare repositories. */
  gitBase?: string;
  /** What the sandboxed terminal may reach: package registries. */
  allowedDomains?: string[];
  timeoutMs?: number;
  /** When set, Claude Code's own terminal (Bash) is off and its sandbox unused: every command goes through the
   * terminal tool to this remote container. The session keeps its file tools on the same copy. */
  terminal?: RemoteTerminal;
};

const REGISTRIES = ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org"];
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"]);
const SERVER = "task";

/** No hook, no fsmonitor, whatever a repository's config says. */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];
const UPLOAD_PACK = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false upload-pack";

/**
 * git run by this process: a scrubbed environment (none of the agent's secrets), and the token, when needed, as a
 * header given through this one command's environment (not its arguments, which any process can list). Never run in
 * the copy: the session writes there, its config and hooks are not trusted.
 */
function git(args: string[], options: { cwd?: string; token?: string } = {}) {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of ["PATH", "HOME", "LANG"]) if (process.env[key]) env[key] = process.env[key]!;
  if (options.token) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`,
    });
  }
  return exec("git", [...SAFE, ...args], { cwd: options.cwd, env, maxBuffer: 10_000_000 }).then((r) => r.stdout.trim());
}

/** The copy's branch, brought into the vault: a fetch from the copy, which runs no code of the copy's. */
async function syncFromCopy(vault: string, dir: string, branch: string) {
  await git(["fetch", "--quiet", "--no-tags", `--upload-pack=${UPLOAD_PACK}`, dir, `+refs/heads/${branch}:refs/heads/${branch}`], { cwd: vault });
}

/**
 * The task's copy, cloned once from the vault (a bare repository this process owns, fed from the remote), on its
 * branch, kept for the next runs. The copy holds no token and no link to the remote. Returns the branch's last
 * commits, and when someone else pushed to the branch, a bundle of the remote branch for the session to merge.
 */
export async function prepareCopy(dir: string, vault: string, remote: string, branch: string, token: string): Promise<{ log: string; upstream?: string }> {
  if (!existsSync(join(vault, "HEAD"))) {
    rmSync(vault, { recursive: true, force: true });
    mkdirSync(vault, { recursive: true });
    await git(["clone", "--quiet", "--bare", remote, vault], { token });
  }
  if (!existsSync(join(dir, ".git"))) {
    // A clone cut halfway leaves no .git: start over, from what the remote holds now.
    await git(["fetch", "--quiet", "--no-tags", remote, "+refs/heads/*:refs/heads/*"], { cwd: vault, token });
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // --no-local: copied, not hard-linked, so the session cannot reach the vault's objects through its own.
    await git(["clone", "--quiet", "--no-local", vault, dir]);
    const pushed = await git(["branch", "-r", "--list", `origin/${branch}`], { cwd: dir });
    await git(["checkout", "--quiet", "-B", branch, ...(pushed ? [`origin/${branch}`] : [])], { cwd: dir });
  } else {
    await syncFromCopy(vault, dir, branch).catch(() => undefined);
  }
  const log = await git(["log", "--oneline", "-5", `refs/heads/${branch}`], { cwd: vault }).catch(() => "");
  // The remote branch moved (a suggestion committed on the PR): its commits, as a file the session can fetch.
  const upstream = `refs/upstream/${branch}`;
  const fetched = await git(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${upstream}`], { cwd: vault, token }).then(
    () => true,
    () => false,
  );
  if (!fetched) return { log };
  const behind = await git(["merge-base", "--is-ancestor", upstream, `refs/heads/${branch}`], { cwd: vault }).then(
    () => false,
    () => true,
  );
  if (!behind) return { log };
  const bundle = `${vault}.upstream.bundle`;
  rmSync(bundle, { force: true });
  await git(["bundle", "create", "--quiet", bundle, upstream], { cwd: vault });
  return { log, upstream: bundle };
}

/** Only the task's branch, from the vault, to the remote named here: nothing in the copy decides where it goes. */
export async function pushBranch(dir: string, vault: string, remote: string, branch: string, token: string) {
  await syncFromCopy(vault, dir, branch);
  await git(["push", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: vault, token });
}

/** The commits' author, in the terminal's environment. */
export function gitIdentity(name: string): Record<string, string> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@users.noreply.github.com`;
  return { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email };
}

/** The terminal sees none of the agent's secrets. */
function cleanEnvironment(name: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, gitIdentity(name), { CI: "1" });
  // Claude itself must be logged in; every command it runs gets the credentials stripped.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) Object.assign(env, { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
  if (process.env.ANTHROPIC_API_KEY) Object.assign(env, { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
  return env;
}

/** Inside the copy, symlinks followed, never in its .git (whatever the case: macOS does not care). */
export function insideCopy(dir: string, path: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      const parent = dirname(p);
      return parent === p ? p : join(real(parent), basename(p));
    }
  };
  const root = real(dir);
  const target = real(resolve(dir, path));
  if (target !== root && !target.startsWith(root + sep)) return false;
  return !relative(root, target).split(sep).some((part) => part.toLowerCase() === ".git");
}

/** A file tool's use: its path inside the copy, and its glob (Glob's pattern, Grep's glob) relative, never climbing
 * out or into .git: a pattern is a path too. */
export function fileUseAllowed(dir: string, name: string, input: Record<string, unknown>): boolean {
  const patterns = [name === "Glob" ? input.pattern : undefined, input.glob].filter((p): p is string => typeof p === "string");
  const safe = (p: string) => !isAbsolute(p) && !p.startsWith("~") && !p.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === ".git");
  return patterns.every(safe) && insideCopy(dir, String(input.file_path ?? input.path ?? input.notebook_path ?? "."));
}

/** The terminal tool, opening the remote terminal at its first command; env is exported before each command. */
export function terminalTool(open: () => Promise<Terminal>, env: Record<string, string> = {}) {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", `'\\''`)}'\n`)
    .join("");
  return tool(
    "terminal",
    "Run a bash command in your copy's container (git, node, npm, pnpm, python3, jq, rg…). Each call is a new bash starting in the copy's folder, at the same path as your file tools see it: chain with && or cd in the same command; nothing stays in the background between calls. Network: package registries only. Returns the exit code and the output (stdout and stderr, the end when long). Give a long command (install, tests) enough time.",
    {
      command: z.string().min(1),
      timeout_seconds: z.number().int().min(5).max(1800).default(600).describe("Beyond it the command is stopped (exit code 124)"),
    },
    async ({ command, timeout_seconds }) => {
      try {
        const terminal = await open();
        const { code, output } = await terminal.run(exports + command, timeout_seconds);
        return { content: [{ type: "text" as const, text: `exit code ${code}\n${output || "(no output)"}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `The terminal failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );
}

const resultSchema = z.object({ report: z.string().describe("Your report, short, in your voice: what you did, the PR link, what is left or to check") });

/**
 * Code tasks done by a Claude Code session in the task's copy. Its terminal runs in Claude Code's sandbox: it writes
 * only in the copy, reaches only package registries, and holds no token. Pushing and opening the PR go through tools
 * of this process, on the task's branch only. Anything the sandbox and the rules do not allow is refused.
 * With a remote terminal, Claude Code's own terminal is off: every command runs in that container instead.
 */
export function claudeCodeRunner(options: ClaudeCodeOptions): TaskRunner {
  const workspace = resolve(options.workspace);
  const vaults = resolve(options.vault ?? `${workspace}-vault`);
  const base = options.gitBase ?? "https://github.com";
  // The copies are written here and in the remote container (another uid, allowed by an ACL): files group-writable.
  if (options.terminal) process.umask(0o002);

  async function github<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${options.githubToken}`, accept: "application/vnd.github+json", "user-agent": "agent-core", ...(init.headers ?? {}) },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${body.slice(0, 300)}`);
    return JSON.parse(body) as T;
  }

  return async (run: TaskRun): Promise<TaskOutcome> => {
    const { task } = run;
    const dir = join(workspace, `task-${task.id}`);
    const vault = join(vaults, `task-${task.id}.git`);
    const remote = `${base}/${task.repo}.git`;
    const prepared = await prepareCopy(dir, vault, remote, task.branch, options.githubToken);
    const { log } = prepared;
    let upstream = prepared.upstream;
    // The remote container sees the copy only: the bundle goes into it (its .git, never committed).
    if (upstream && options.terminal) {
      const inside = join(dir, ".git", "upstream.bundle");
      copyFileSync(upstream, inside);
      upstream = inside;
    }
    let pr = task.pr;
    const remoteTerminal = options.terminal;
    let opened: Promise<Terminal> | undefined;
    const openTerminal = () => {
      if (!remoteTerminal) throw new Error("no remote terminal");
      if (!opened) {
        opened = remoteTerminal(dir);
        opened.catch(() => (opened = undefined));
      }
      return opened;
    };

    const server = createSdkMcpServer({
      name: SERVER,
      version: "1.0.0",
      tools: [
        tool("progress", "One sentence of news in the conversation during a long task (at most 5, a few minutes apart).", { text: z.string().min(1).max(400) }, async ({ text }) => {
          run.progress(text);
          return { content: [{ type: "text" as const, text: "Noted." }] };
        }),
        tool("push_branch", `Push the copy's commits to the task's branch (${task.branch}). Commit first.`, {}, async () => {
          await pushBranch(dir, vault, remote, task.branch, options.githubToken);
          return { content: [{ type: "text" as const, text: `Pushed to ${task.branch}.` }] };
        }),
        tool("open_pr", "Open the task's pull request (one per task; it already exists after the first time). Push first.", { title: z.string(), body: z.string() }, async ({ title, body }) => {
          if (pr) return { content: [{ type: "text" as const, text: `PR #${pr} already open: pushing updates it.` }] };
          const repo = await github<{ default_branch: string }>(`/repos/${task.repo}`);
          const opened = await github<{ number: number; html_url: string }>(`/repos/${task.repo}/pulls`, {
            method: "POST",
            body: JSON.stringify({ title, body, head: task.branch, base: repo.default_branch }),
          });
          pr = opened.number;
          run.setPr(opened.number);
          return { content: [{ type: "text" as const, text: `PR #${opened.number} opened: ${opened.html_url}` }] };
        }),
        ...(remoteTerminal ? [terminalTool(openTerminal, gitIdentity(options.name))] : []),
      ],
    });

    // File tools inside the copy only, never its .git; the terminal is bounded by the sandbox; the task's own tools.
    const canUseTool: CanUseTool = async (name, input) => {
      if (name.startsWith(`mcp__${SERVER}__`)) return { behavior: "allow", updatedInput: input };
      if (FILE_TOOLS.has(name)) {
        if (fileUseAllowed(dir, name, input)) return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: `${name} is not allowed in a code task: do without, or say what you are missing in your report.` };
    };

    // Without a remote terminal, Claude Code's own, in its sandbox: writes in the copy only, never its git config or
    // hooks; reads nothing of the agent's (its folder, its home); network to package registries only.
    const sandbox = {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: options.allowedDomains ?? REGISTRIES },
      filesystem: {
        allowWrite: [dir],
        denyWrite: [join(dir, ".git", "config"), join(dir, ".git", "hooks")],
        denyRead: [homedir(), process.cwd(), vaults, ...(options.denyRead ?? [])],
        allowRead: [dir, ...(upstream ? [upstream] : [])],
      },
    };

    const abort = new AbortController();
    const stop = () => abort.abort();
    run.signal.addEventListener("abort", stop);
    const timer = setTimeout(stop, options.timeoutMs ?? 45 * 60_000);
    timer.unref?.();
    try {
      const session = query({
        prompt: [
          run.resumed ? "A restart cut your previous run of this task: the copy may hold your work in progress, look at it first." : "",
          `Request (task #${task.id}, "${task.title}", ${task.repo}):\n<request>\n${run.request}\n</request>`,
          `The conversation it comes from:\n<conversation>\n${run.conversation || "(none)"}\n</conversation>`,
          `The copy (${dir}), on branch ${task.branch}${pr ? `, PR #${pr} open` : ""}, last commits:\n<git>\n${log || "(none yet)"}\n</git>`,
          upstream
            ? `Someone pushed to ${task.branch} on the remote: your copy lacks those commits and a push would be refused. First: git fetch ${upstream} refs/upstream/${task.branch} && git merge FETCH_HEAD (resolve conflicts if any).`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        options: {
          systemPrompt: `${options.persona}\n\nYou are doing a code task in your own copy of ${task.repo}. Read the code and follow its conventions, make a focused change, run the project's checks, commit, then push_branch and open_pr. Never merge, never push elsewhere: it is enforced. Give news with progress on long tasks. End with a short report.${remoteTerminal ? " Your terminal is the terminal tool (a container with only your copy); read and change files with Read, Edit, Write, Glob, Grep." : ""}`,
          cwd: dir,
          ...(options.model ? { model: options.model } : {}),
          ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
          env: cleanEnvironment(options.name),
          mcpServers: { [SERVER]: server },
          allowedTools: [`mcp__${SERVER}__progress`, `mcp__${SERVER}__push_branch`, `mcp__${SERVER}__open_pr`, ...(remoteTerminal ? [`mcp__${SERVER}__terminal`] : [])],
          ...(remoteTerminal ? { tools: ["Read", "Edit", "Write", "Glob", "Grep", "TodoWrite"] } : {}),
          disallowedTools: [...(remoteTerminal ? ["Bash"] : []), "WebFetch", "WebSearch", "Bash(git push:*)", "Bash(git remote:*)", "Bash(git config:*)", "Bash(gh:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(ssh:*)"],
          canUseTool,
          ...(remoteTerminal ? {} : { sandbox }),
          settingSources: [],
          persistSession: false,
          abortController: abort,
          maxTurns: 200,
          outputFormat: { type: "json_schema", schema: jsonSchema(resultSchema) },
        },
      });
      for await (const message of session) {
        if (message.type !== "result") continue;
        if (message.subtype !== "success" || message.is_error) throw new Error(`the session failed (${message.subtype})`);
        return { report: resultSchema.parse(message.structured_output).report, status: pr ? "waiting" : "done" };
      }
      throw new Error("the session stopped without a report");
    } finally {
      clearTimeout(timer);
      run.signal.removeEventListener("abort", stop);
      // The task's container goes with the run (the copy stays, for the next one).
      if (opened) await opened.then((terminal) => terminal.close()).catch((error) => console.error("terminal not closed", error));
    }
  };
}
