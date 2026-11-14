import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createSdkMcpServer, query, tool, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { jsonSchema } from "../claude.ts";
import type { TaskOutcome, TaskRun, TaskRunner } from "../tasks.ts";

const exec = promisify(execFile);

export type ClaudeCodeOptions = {
  /** Where the copies live, one per task. The session writes nowhere else. */
  workspace: string;
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
};

const REGISTRIES = ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org"];
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"]);
const SERVER = "task";

/** git with the token in a header of this one command: it is never written in the copy's config. */
function git(args: string[], options: { cwd?: string; token?: string } = {}) {
  const auth = options.token ? ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`] : [];
  return exec("git", [...auth, ...args], { cwd: options.cwd, maxBuffer: 10_000_000 }).then((r) => r.stdout.trim());
}

/** The task's copy: cloned once, on its branch (from the remote one if it exists), kept for the next runs. */
export async function prepareCopy(dir: string, remote: string, branch: string, token: string) {
  if (!existsSync(join(dir, ".git"))) {
    // A clone cut halfway leaves no .git: start over.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await git(["clone", "--quiet", remote, dir], { token });
    const pushed = await git(["branch", "-r", "--list", `origin/${branch}`], { cwd: dir });
    await git(["checkout", "--quiet", "-B", branch, ...(pushed ? [`origin/${branch}`] : [])], { cwd: dir });
  }
  return git(["log", "--oneline", "-5"], { cwd: dir });
}

/** Only the task's branch, never anything else. */
export async function pushBranch(dir: string, branch: string, token: string) {
  const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  if (current !== branch) throw new Error(`the copy is on ${current}, not on the task's branch ${branch}`);
  await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir, token });
}

/** The terminal sees none of the agent's secrets. */
function cleanEnvironment(name: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key]!;
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@users.noreply.github.com`;
  Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email, CI: "1" });
  // Claude itself must be logged in; every command it runs gets the credentials stripped.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) Object.assign(env, { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
  if (process.env.ANTHROPIC_API_KEY) Object.assign(env, { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
  return env;
}

const resultSchema = z.object({ report: z.string().describe("Your report, short, in your voice: what you did, the PR link, what is left or to check") });

/**
 * Code tasks done by a Claude Code session in the task's copy. Its terminal runs in Claude Code's sandbox: it writes
 * only in the copy, reaches only package registries, and holds no token. Pushing and opening the PR go through tools
 * of this process, on the task's branch only. Anything the sandbox and the rules do not allow is refused.
 */
export function claudeCodeRunner(options: ClaudeCodeOptions): TaskRunner {
  const workspace = resolve(options.workspace);
  const base = options.gitBase ?? "https://github.com";

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
    const log = await prepareCopy(dir, `${base}/${task.repo}.git`, task.branch, options.githubToken);
    const status = await git(["status", "--short"], { cwd: dir });
    let pr = task.pr;

    const server = createSdkMcpServer({
      name: SERVER,
      version: "1.0.0",
      tools: [
        tool("progress", "One sentence of news in the conversation during a long task (at most 5, a few minutes apart).", { text: z.string().min(1).max(400) }, async ({ text }) => {
          run.progress(text);
          return { content: [{ type: "text" as const, text: "Noted." }] };
        }),
        tool("push_branch", `Push the copy's commits to the task's branch (${task.branch}). Commit first.`, {}, async () => {
          await pushBranch(dir, task.branch, options.githubToken);
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
      ],
    });

    // File tools inside the copy only; the terminal is bounded by the sandbox; the task's own tools; nothing else.
    const canUseTool: CanUseTool = async (name, input) => {
      if (name.startsWith(`mcp__${SERVER}__`)) return { behavior: "allow", updatedInput: input };
      if (FILE_TOOLS.has(name)) {
        const path = resolve(dir, String(input.file_path ?? input.path ?? input.notebook_path ?? "."));
        if (path === dir || path.startsWith(dir + sep)) return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: `${name} is not allowed in a code task: do without, or say what you are missing in your report.` };
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
          `The copy (${dir}), on branch ${task.branch}${pr ? `, PR #${pr} open` : ""}:\n<git>\n${log}\n${status}\n</git>`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        options: {
          systemPrompt: `${options.persona}\n\nYou are doing a code task in your own copy of ${task.repo}. Read the code and follow its conventions, make a focused change, run the project's checks, commit, then push_branch and open_pr. Never merge, never push elsewhere: it is enforced. Give news with progress on long tasks. End with a short report.`,
          cwd: dir,
          ...(options.model ? { model: options.model } : {}),
          ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
          env: cleanEnvironment(options.name),
          mcpServers: { [SERVER]: server },
          allowedTools: [`mcp__${SERVER}__progress`, `mcp__${SERVER}__push_branch`, `mcp__${SERVER}__open_pr`],
          disallowedTools: ["WebFetch", "WebSearch", "Bash(git push:*)", "Bash(git remote:*)", "Bash(git config:*)", "Bash(gh:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(ssh:*)"],
          canUseTool,
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            network: { allowedDomains: options.allowedDomains ?? REGISTRIES },
            filesystem: { allowWrite: [dir], denyRead: [homedir()], allowRead: [dir] },
          },
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
    }
  };
}
