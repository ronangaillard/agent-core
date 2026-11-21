import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { jsonSchema } from "../claude.ts";
import { Prompts } from "../prompts.ts";
import type { TaskOutcome, TaskRun, TaskRunner } from "../tasks.ts";
import type { OpenWorkshop, Workshop } from "./apercu.ts";

const exec = promisify(execFile);

export type ClaudeCodeOptions = {
  /** Where the copies live, one per task, at the same path in the workshop. */
  workspace: string;
  /** This process's own bare repositories, one per task, fed from the remote. */
  vault?: string;
  /** The default GitHub token: the session's, for the task's repository (fine-grained, limited to the repositories). */
  githubToken: string;
  /** Tokens by repository owner (case-insensitive), e.g. one per organisation; githubToken for the others. */
  githubTokens?: Record<string, string>;
  /** The agent, as the session's system prompt starts: the default of the persona prompt. */
  persona: string;
  /** The editable texts (persona, code-task); default: the built-in ones. */
  prompts?: Prompts;
  name: string;
  model?: string;
  /** Where each task's Claude Code session runs, whole: a container with the copy and the session's tokens only. */
  workshop: OpenWorkshop;
  /** Claude's own login for the session (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY); default: this process's. */
  claudeEnv?: Record<string, string>;
  /** Where each run's session output is kept, one file per run, 14 days (default: <workspace>-sessions). */
  transcripts?: string;
  /** Default: github.com and api.github.com. Tests point them elsewhere. */
  gitBase?: string;
  githubApi?: string;
  timeoutMs?: number;
};

/** No hook, no fsmonitor, whatever a repository's config says. */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];
const UPLOAD_PACK = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false upload-pack";

/**
 * git run by this process: a scrubbed environment (none of the agent's secrets), and the token, when needed, as a
 * header given through this one command's environment (not its arguments, which any process can list). Never run in
 * the copy once the session has had it: its config and hooks are not trusted.
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
 * branch, kept for the next runs (the session sets its origin to the remote, in its own container).
 * Returns the branch's last commits.
 */
export async function prepareCopy(
  dir: string,
  vault: string,
  remote: string,
  branch: string,
  token: string,
  options: { restartEmpty?: boolean } = {},
): Promise<{ log: string }> {
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
    await git(["clone", "--quiet", "--no-local", vault, dir]);
    const pushed = await git(["branch", "-r", "--list", `origin/${branch}`], { cwd: dir });
    await git(["checkout", "--quiet", "-B", branch, ...(pushed ? [`origin/${branch}`] : [])], { cwd: dir });
  } else {
    await syncFromCopy(vault, dir, branch).catch(() => undefined);
    // No commit of its own yet: the branch starts again from the remote's default branch as it is now (a copy left
    // on an old main would work on stale code). The copy goes; its leftovers had no commit.
    if (options.restartEmpty && (await withoutOwnCommits(vault, remote, branch, token))) {
      await git(["update-ref", "-d", `refs/heads/${branch}`], { cwd: vault });
      rmSync(dir, { recursive: true, force: true });
      return prepareCopy(dir, vault, remote, branch, token);
    }
  }
  const log = await git(["log", "--oneline", "-5", `refs/heads/${branch}`], { cwd: vault }).catch(() => "");
  return { log };
}

/** The branch, in the vault, is behind (or at) the remote's default branch, fetched now; never pushed. */
async function withoutOwnCommits(vault: string, remote: string, branch: string, token: string): Promise<boolean> {
  try {
    const main = await git(["symbolic-ref", "--short", "HEAD"], { cwd: vault });
    if (main === branch) return false;
    const pushed = await git(["ls-remote", "--heads", remote, branch], { cwd: vault, token });
    if (pushed) return false;
    await git(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${main}:refs/heads/${main}`], { cwd: vault, token });
    await git(["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/heads/${main}`], { cwd: vault });
    return true;
  } catch {
    return false;
  }
}

/** The token for a repository ("owner/name"): its owner's, else the default. */
export function tokenFor(repo: string, fallback: string, byOwner: Record<string, string> = {}): string {
  const owner = repo.split("/")[0]!.toLowerCase();
  const match = Object.entries(byOwner).find(([key]) => key.toLowerCase() === owner);
  return match ? match[1] : fallback;
}

/**
 * Tokens by owner from the environment: GITHUB_TOKEN_<OWNER>, the owner in capitals with "-" as "_" (GitHub logins
 * are letters, digits and dashes). GITHUB_TOKEN_ACME_LABS → acme-labs.
 */
export function tokensFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const owner = /^GITHUB_TOKEN_([A-Z0-9_]+)$/.exec(key)?.[1];
    if (owner && value) tokens[owner.toLowerCase().replaceAll("_", "-")] = value;
  }
  return tokens;
}

/** The commits' author, in the terminal's environment. */
export function gitIdentity(name: string): Record<string, string> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@users.noreply.github.com`;
  return { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email };
}

const resultSchema = z.object({ report: z.string().describe("Your report, short, in your voice: what you did, the PR link, what is left or to check") });

/** An env value stays under Linux's limit for one string (128 KiB, in bytes): the conversation is cut from its start. */
const ENV_MAX = 120_000;
export function fit(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // Cut on a character boundary: skip continuation bytes (10xxxxxx).
  let start = bytes.length - Math.max(0, maxBytes - 10);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return `…(cut)\n${bytes.subarray(start).toString("utf8")}`;
}

/**
 * The session, in the workshop: Claude Code headless in the copy, with the repository's own settings (CLAUDE.md,
 * skills, hooks, its agents) but none of its MCP servers, no web tools, no permission prompts (the container is the
 * sandbox). Its input comes through the environment, never through files this process would write into the copy.
 */
export const SESSION_COMMAND = [
  // The copy's origin is the remote itself (a copy cloned from the vault points there first): the session pushes to it.
  'git remote set-url origin "$AGENT_REMOTE" &&',
  'printf "%s" "$AGENT_PROMPT" | claude -p',
  '--model "$AGENT_MODEL"',
  "--output-format stream-json --verbose",
  "--dangerously-skip-permissions",
  "--setting-sources project",
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`,
  "--disallowedTools WebSearch WebFetch",
  "--max-turns 300",
  '--append-system-prompt "$AGENT_SYSTEM"',
  '--json-schema "$AGENT_SCHEMA"',
].join(" ");

type TaskInput = { todos?: { content?: string; activeForm?: string; status?: string }[]; subject?: string; activeForm?: string; taskId?: string; status?: string };
type StreamMessage = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  message?: { content?: { type?: string; name?: string; input?: TaskInput }[] };
};

/**
 * Reads the session's stream (stream-json, one message a line): its news is its task list's item in progress, each
 * time it changes (TaskCreate and TaskUpdate, the headless task tools, numbered "1", "2"… as created; or TodoWrite);
 * its end is its result. Lines that are not JSON (a crash, the shell) are kept for the failure.
 */
export async function readSession(lines: AsyncGenerator<string, number>, progress: (text: string) => void): Promise<{ report: string }> {
  let said = "";
  const tasks = new Map<string, string>();
  const say = (text: string | undefined) => {
    if (text && text !== said) progress((said = text));
  };
  let result: StreamMessage | undefined;
  const noise: string[] = [];
  let step = await lines.next();
  while (!step.done) {
    const line = step.value;
    let message: StreamMessage | undefined;
    try {
      message = JSON.parse(line) as StreamMessage;
    } catch {
      if (line.trim()) noise.push(line.slice(0, 300));
      if (noise.length > 20) noise.shift();
    }
    if (message?.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type !== "tool_use") continue;
        const input = block.input ?? {};
        if (block.name === "TaskCreate") tasks.set(String(tasks.size + 1), input.activeForm || input.subject || "");
        if (block.name === "TaskUpdate" && input.status === "in_progress" && input.taskId) say(input.activeForm || tasks.get(input.taskId));
        if (block.name === "TodoWrite") {
          const doing = input.todos?.find((todo) => todo.status === "in_progress");
          say(doing?.activeForm || doing?.content);
        }
      }
    }
    if (message?.type === "result") {
      // Its final word: the run is over, even if the process stays (background agents it started, which would wake it
      // again and keep working on the branch). The caller closes the workshop, which stops them.
      result = message;
      break;
    }
    step = await lines.next();
  }
  const code = step.done ? step.value : undefined;
  if (!result) throw new Error(`the session stopped without a result (exit ${code})${noise.length ? `: ${noise.slice(-5).join(" / ")}` : ""}`);
  if (result.subtype !== "success" || result.is_error) throw new Error(`the session failed (${result.subtype}${result.result ? `: ${result.result.slice(0, 300)}` : ""})`);
  const parsed = resultSchema.safeParse(result.structured_output);
  return { report: parsed.success ? parsed.data.report : (result.result ?? "").trim() || "(no report)" };
}

const KEEP_TRANSCRIPTS_MS = 14 * 24 * 3600_000;

/**
 * A run's transcript file (task-<id>-<start>.jsonl): the session's stream as it came, to see afterwards where the time
 * went, since the workshop and its Claude Code logs go with the run. The ones older than 14 days go. Never in the copy.
 */
export function transcriptFile(dir: string, taskId: number, resumed: boolean): string {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (Date.now() - statSync(path).mtimeMs > KEEP_TRANSCRIPTS_MS) rmSync(path, { force: true });
  }
  return join(dir, `task-${taskId}-${new Date().toISOString().replace(/[:.]/g, "-")}${resumed ? "-resumed" : ""}.jsonl`);
}

/** The lines, unchanged, each also appended to file (a failed write loses the transcript, never the run). */
export async function* kept(lines: AsyncGenerator<string, number>, file: string): AsyncGenerator<string, number> {
  let step = await lines.next();
  while (!step.done) {
    try {
      appendFileSync(file, `${step.value}\n`);
    } catch {
      // The transcript is for debugging only.
    }
    yield step.value;
    step = await lines.next();
  }
  return step.value;
}

/**
 * Code tasks: a Claude Code session in the task's workshop, the whole of it (its terminal, its git, its gh), with the
 * repository's own procedures. It commits, pushes the task's branch and opens the PR itself, with a GitHub token
 * limited to the task's repositories; this process prepares the copy before and finds the PR after.
 */
export function claudeCodeRunner(options: ClaudeCodeOptions): TaskRunner {
  const workspace = resolve(options.workspace);
  const vaults = resolve(options.vault ?? `${workspace}-vault`);
  const transcripts = resolve(options.transcripts ?? `${workspace}-sessions`);
  const base = options.gitBase ?? "https://github.com";
  const api = options.githubApi ?? "https://api.github.com";
  // The copies are written here and in the workshop (another uid, allowed by an ACL): files group-writable.
  process.umask(0o002);

  async function github<T>(token: string, path: string): Promise<T> {
    const response = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "agent-core" } });
    const body = await response.text();
    if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${body.slice(0, 300)}`);
    return JSON.parse(body) as T;
  }

  /** The task's PR, opened by the session: the newest one from its branch. */
  async function findPr(repo: string, branch: string, token: string): Promise<number | undefined> {
    const owner = repo.split("/")[0]!;
    const pulls = await github<{ number: number }[]>(token, `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=1`);
    return pulls[0]?.number;
  }

  const runner: TaskRunner = async (run: TaskRun): Promise<TaskOutcome> => {
    const { task } = run;
    const dir = join(workspace, `task-${task.id}`);
    const vault = join(vaults, `task-${task.id}.git`);
    const remote = `${base}/${task.repo}.git`;
    const token = tokenFor(task.repo, options.githubToken, options.githubTokens);
    // A run asked again (not one a restart cut, whose copy may hold work in progress) restarts an empty branch.
    const { log } = await prepareCopy(dir, vault, remote, task.branch, token, { restartEmpty: !run.resumed });
    const prompts = options.prompts ?? new Prompts();
    if (!options.prompts) prompts.seed("persona", options.persona);

    const prompt = [
      run.resumed ? "A restart cut your previous run of this task: the copy may hold your work in progress, look at it first." : "",
      `Request (task #${task.id}, "${task.title}", ${task.repo}):\n<request>\n${run.request}\n</request>`,
      `The conversation it comes from:\n<conversation>\n${fit(run.conversation || "(none)", ENV_MAX - 20_000 - Buffer.byteLength(run.request))}\n</conversation>`,
      `Your copy, on branch ${task.branch}${task.pr ? `, PR #${task.pr} open` : ""}, last commits:\n<git>\n${log || "(none yet)"}\n</git>`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const claude = options.claudeEnv ?? Object.fromEntries(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
    const env: Record<string, string> = {
      ...claude,
      GH_TOKEN: token,
      AGENT_REMOTE: remote,
      // The task tools (TaskCreate, TaskUpdate): off in headless mode unless asked; they carry the session's news.
      CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
      // Nothing in the background: a turn that ends to wait for a background agent (a repository's PR reviewers) gets
      // the structured-output nudge, writes its report early, and that report ends the run before the PR is open.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      ...gitIdentity(options.name),
      AGENT_MODEL: options.model ?? "opus",
      AGENT_PROMPT: prompt,
      AGENT_SYSTEM: [prompts.text("persona"), prompts.text("code-task", { repo: task.repo, branch: task.branch })].join("\n\n"),
      AGENT_SCHEMA: JSON.stringify(jsonSchema(resultSchema)),
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };

    const abort = new AbortController();
    const stop = () => abort.abort();
    run.signal.addEventListener("abort", stop);
    const timer = setTimeout(stop, options.timeoutMs ?? 90 * 60_000);
    timer.unref?.();
    let workshop: Workshop | undefined;
    // The PR the session opened, kept even when the session ends badly after opening it.
    const notePr = async () => {
      const pr = task.pr ?? (await findPr(task.repo, task.branch, token).catch(() => undefined));
      if (pr && pr !== task.pr) run.setPr(pr);
      return pr;
    };
    try {
      workshop = await options.workshop(dir);
      const lines = kept(workshop.session(SESSION_COMMAND, env, abort.signal), transcriptFile(transcripts, task.id, run.resumed));
      const { report } = await readSession(lines, run.progress);
      const pr = await notePr();
      return { report, status: pr ? "waiting" : "done" };
    } catch (error) {
      if (workshop && !run.signal.aborted) await notePr();
      if (abort.signal.aborted && !run.signal.aborted) throw new Error("the session took too long and was stopped");
      throw error;
    } finally {
      clearTimeout(timer);
      run.signal.removeEventListener("abort", stop);
      // The task's container goes with the run (the copy stays, for the next one): it stops the session too.
      if (workshop) await workshop.close().catch((error: unknown) => console.error("workshop not closed", error));
    }
  };
  // A finished task's copy and its bare repository: its branch is on the remote (or was merged), nothing is lost.
  runner.forget = (taskId) => {
    for (const path of [join(workspace, `task-${taskId}`), join(vaults, `task-${taskId}.git`)]) rmSync(path, { recursive: true, force: true });
  };
  return runner;
}
