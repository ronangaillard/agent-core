import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { Address, Connector, DeliverResult, InboxRow, Thread } from "../types.ts";

export type GithubOptions = {
  /** The webhook secret: every delivery is signed with it (X-Hub-Signature-256). */
  secret: string;
  port: number;
  /** For read() and the catch-up: the repositories' recent deployments and runs. */
  token?: string;
  /** The repositories the catch-up reads. */
  repos?: string[];
  /**
   * Workflows (by name) whose finished runs on the default branch count, for repositories that deploy from a workflow
   * without GitHub deployments (e.g. "Deploy to production"). None: workflow runs are ignored.
   */
  workflows?: string[];
  /** Default: api.github.com. */
  api?: string;
};

type Deployment = { id: number; ref?: string; sha?: string; environment?: string; creator?: { login?: string } };
type Status = { state?: string; created_at?: string; target_url?: string | null; environment_url?: string | null };
type Run = {
  id: number;
  run_attempt?: number;
  name?: string;
  head_branch?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  updated_at?: string;
  actor?: { login?: string };
};
/** A name chosen by whoever can write to the repository (an environment, a ref): kept only if it looks like one. */
const word = (value: string | undefined) => (value && /^[\w./-]{1,100}$/.test(value) ? value : "?");
/** Only GitHub's own links: a status URL is free text too. */
const githubLink = (value: string | null | undefined) => (value && /^https:\/\/github\.com\/[\w./?=&%-]+$/.test(value) ? value : undefined);

/** A raw event: what a webhook delivery or the catch-up hands to toInbox. */
type Raw = { repo: string } & ({ kind: "deployment"; deployment: Deployment; status: Status } | { kind: "run"; defaultBranch?: string; run: Run });

const FINAL = new Set(["success", "failure", "error"]);
/** A run that ended for real: a cancelled one (often replaced by a newer run) says nothing. */
const RUN_FINAL = new Set(["success", "failure", "timed_out", "startup_failure"]);

export function signatureOk(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * GitHub as a connector: one conversation per repository (github:<owner>/<repo>), where deployments that finished and
 * finished runs of the watched workflows on the default branch arrive as messages from GitHub. Nobody can be answered
 * there: its form has no message and deliver refuses, so the agent acts with its tools (or does nothing). The text of
 * an event holds only what GitHub guarantees (ids, commit, states, logins, GitHub links; names that look like names),
 * never free text written by others:
 * the agent reads the rest itself (GitHub's MCP server). Rows are private: they never come up elsewhere.
 */
export function githubConnector(options: GithubOptions): Connector & { handle(event: string | undefined, signature: string | undefined, body: string): number } {
  let server: Server | undefined;
  let sink: ((raw: unknown) => void) | undefined;
  const watched = new Set(options.workflows ?? []);
  const base = options.api ?? "https://api.github.com";

  const addressOf = (repo: string): Address => ({ connector: "github", conversation: repo, thread: "main" });

  /** An event as the agent reads it: a line of facts. */
  function describe(raw: Raw): string | null {
    if (raw.kind === "deployment") {
      const { deployment, status } = raw;
      if (!status.state || !FINAL.has(status.state)) return null;
      const by = deployment.creator?.login ? ` by ${word(deployment.creator.login)}` : "";
      const link = githubLink(status.target_url) ?? githubLink(status.environment_url);
      const sha = deployment.sha && /^[0-9a-f]{7,40}$/.test(deployment.sha) ? `, commit ${deployment.sha}` : "";
      return `Deployment ${deployment.id} of ${raw.repo} (${word(deployment.ref)}${sha}) to ${word(deployment.environment)}${by}: ${status.state}.${link ? ` ${link}` : ""}`;
    }
    const { run } = raw;
    if (run.status !== "completed" || !run.conclusion || !RUN_FINAL.has(run.conclusion)) return null;
    if (!run.name || !watched.has(run.name) || !raw.defaultBranch || run.head_branch !== raw.defaultBranch) return null;
    const by = run.actor?.login ? ` by ${word(run.actor.login)}` : "";
    const link = githubLink(run.html_url);
    return `Workflow "${run.name}" of ${raw.repo} on ${run.head_branch}${by}: ${run.conclusion}. Commit ${run.head_sha ?? "?"}, run ${run.id}${link ? ` ${link}` : ""}.`;
  }

  const at = (raw: Raw) => (raw.kind === "deployment" ? raw.status.created_at : raw.run.updated_at) ?? new Date().toISOString();

  async function api<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${options.token}`, accept: "application/vnd.github+json", "user-agent": "agent-core" },
    });
    if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
    return (await response.json()) as T;
  }

  /**
   * A repository's recent events, oldest first. strict (the catch-up): a failed read throws, so the core tries again
   * and the cursor does not move past what was missed; a read the token has no right to (403, 404) is only skipped.
   * Otherwise (read()): whatever could be read.
   */
  async function recent(repo: string, strict = false): Promise<Raw[]> {
    const found: Raw[] = [];
    if (!options.token) return found;
    const tolerate = (what: string, error: unknown) => {
      const status = Number(/: (\d{3})$/.exec(error instanceof Error ? error.message : "")?.[1]);
      if (strict && status !== 403 && status !== 404) throw error;
      console.error(`github: ${repo}'s ${what} not read`, error);
    };
    try {
      for (const deployment of await api<Deployment[]>(`/repos/${repo}/deployments?per_page=10`)) {
        const [status] = await api<Status[]>(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`);
        if (status) found.push({ repo, kind: "deployment", deployment, status });
      }
    } catch (error) {
      tolerate("deployments", error);
    }
    if (watched.size) {
      try {
        const { default_branch: branch } = await api<{ default_branch: string }>(`/repos/${repo}`);
        const { workflow_runs: runs } = await api<{ workflow_runs: Run[] }>(`/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=100`);
        for (const run of runs) found.push({ repo, kind: "run", defaultBranch: branch, run });
      } catch (error) {
        tolerate("workflow runs", error);
      }
    }
    return found.filter((raw) => describe(raw) !== null).sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)));
  }

  /** One webhook delivery: the HTTP status to answer; the event goes to the core. */
  function handle(event: string | undefined, signature: string | undefined, body: string): number {
    if (!signatureOk(body, signature, options.secret)) return 401;
    if (event === "ping") return 200;
    try {
      JSON.parse(body);
    } catch {
      return 400;
    }
    if (event === "workflow_run") {
      const payload = JSON.parse(body) as { action?: string; repository?: { full_name?: string; default_branch?: string }; workflow_run?: Run };
      if (!payload.workflow_run || !payload.repository?.full_name) return 400;
      if (payload.action === "completed") sink?.({ repo: payload.repository.full_name, kind: "run", defaultBranch: payload.repository.default_branch, run: payload.workflow_run } satisfies Raw);
      return 202;
    }
    if (event !== "deployment_status") return 204;
    const payload = JSON.parse(body) as { repository?: { full_name?: string }; deployment?: Deployment; deployment_status?: Status };
    if (!payload.deployment || !payload.deployment_status || !payload.repository?.full_name) return 400;
    sink?.({ repo: payload.repository.full_name, kind: "deployment", deployment: payload.deployment, status: payload.deployment_status } satisfies Raw);
    return 202;
  }

  return {
    id: "github",
    handle,

    async start(receive) {
      sink = receive;
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_000_000) request.destroy();
          else chunks.push(chunk);
        });
        request.on("end", () => {
          let status = 405;
          try {
            if (request.method === "POST") status = handle(request.headers["x-github-event"] as string | undefined, request.headers["x-hub-signature-256"] as string | undefined, Buffer.concat(chunks).toString("utf8"));
          } catch (error) {
            console.error("github: webhook not read", error);
            status = 400;
          }
          response.writeHead(status).end();
        });
      });
      await new Promise<void>((resolve) => server!.listen(options.port, resolve));
    },

    async stop() {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },

    async toInbox(input) {
      const raw = input as Raw;
      const text = describe(raw);
      if (text === null) return null;
      const address = addressOf(raw.repo);
      const key = `github:${raw.repo}:main`;
      return {
        source_id: raw.kind === "deployment" ? `github:deploy:${raw.deployment.id}` : `github:run:${raw.run.id}:${raw.run.run_attempt ?? 1}`,
        address,
        thread_key: key,
        mode_key: key,
        author_id: "github",
        author_kind: "system",
        owner_only: false,
        private: true,
        dm: false,
        mentions_agent: false,
        mentions_owner: false,
        sent_at: at(raw),
        payload: raw.kind === "deployment" ? { deployment: raw.deployment.id, state: raw.status.state } : { run: raw.run.id, workflow: raw.run.name, conclusion: raw.run.conclusion },
        text,
      } satisfies InboxRow;
    },

    /** The repository's recent events: the agent sees the previous deployment too. */
    async read(address): Promise<Thread> {
      const events = await recent(address.conversation);
      return {
        label: `on GitHub, ${address.conversation} (nobody reads here)`,
        messages: events.slice(-10).map((raw) => ({ author: "GitHub", text: describe(raw)!, at: at(raw) })),
      };
    },

    async *catchUp(since) {
      for (const repo of options.repos ?? []) for (const raw of await recent(repo, true)) if (at(raw) >= since) yield raw;
    },

    form: {
      schema: () => z.object({ note: z.string().describe("For the trace, one sentence: what you did with this event, or why nothing") }),
      prompts: {
        github:
          "This is GitHub ({{repo}}): events of the repository, nobody reads this conversation and nothing you write here is posted. Act with your tools (read GitHub, tell the people concerned with send) as your memory and instructions say, or do nothing.",
      },
      guide: (row) => ({ prompt: "github", vars: { repo: row.address.conversation } }),
      toPosts: (output) => ({ posts: [], held: false, note: (output as { note?: string }).note ?? "" }),
    },

    async deliver(): Promise<DeliverResult> {
      return { ok: false, transient: false, error: "github: read-only, nothing is posted there" };
    },
  };
}
