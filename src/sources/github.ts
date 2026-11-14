import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Core } from "../core.ts";
import type { Address, InboxRow } from "../types.ts";

export type GithubOptions = {
  /** The webhook secret: every delivery is signed with it (X-Hub-Signature-256). */
  secret: string;
  port: number;
  /** Where deployments are announced. */
  address: Address;
  private?: boolean;
  /** For the pass at start: what finished while the agent was down. */
  token?: string;
  repos?: string[];
  /** The pass at start looks back this far. */
  lookBackMs?: number;
};

type Deployment = { id: number; ref?: string; environment?: string; creator?: { login?: string } };
type Status = { state?: string; created_at?: string; target_url?: string | null; environment_url?: string | null; description?: string | null };

const FINAL = new Set(["success", "failure", "error"]);

export function signatureOk(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * A GitHub source: deployments that finished become system rows in a configured conversation. Only the final state
 * counts, once per deployment (source_id). Webhooks are pushed; a pass at start reads what was missed.
 */
export function githubSource(core: Core, options: GithubOptions) {
  let server: Server | undefined;

  const row = (repo: string, deployment: Deployment, status: Status): InboxRow | null => {
    if (!status.state || !FINAL.has(status.state)) return null;
    const link = status.target_url || status.environment_url;
    const by = deployment.creator?.login ? ` by ${deployment.creator.login}` : "";
    const text = `Deployment of ${repo} (${deployment.ref ?? "?"}) to ${deployment.environment ?? "?"}${by}: ${status.state}.${status.description ? ` ${status.description}` : ""}${link ? ` ${link}` : ""}`;
    const threadKey = core.threadKeyOf(options.address);
    return {
      source_id: `github:deploy:${deployment.id}`,
      address: options.address,
      thread_key: threadKey,
      mode_key: threadKey,
      author_id: "github",
      author_kind: "system",
      owner_only: false,
      private: options.private ?? false,
      dm: false,
      mentions_agent: false,
      mentions_owner: false,
      sent_at: status.created_at ?? new Date().toISOString(),
      payload: { deployment: deployment.id, state: status.state },
      text,
    };
  };

  const ingest = (inbox: InboxRow | null) => (inbox ? core.ingest(inbox, options.address.connector) : null);

  /** One webhook delivery: the HTTP status to answer. */
  function handle(event: string | undefined, signature: string | undefined, body: string): number {
    if (!signatureOk(body, signature, options.secret)) return 401;
    if (event === "ping") return 200;
    if (event !== "deployment_status") return 204;
    const payload = JSON.parse(body) as { repository?: { full_name?: string }; deployment?: Deployment; deployment_status?: Status };
    if (!payload.deployment || !payload.deployment_status) return 400;
    ingest(row(payload.repository?.full_name ?? "?", payload.deployment, payload.deployment_status));
    return 202;
  }

  async function api<T>(path: string): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${options.token}`, accept: "application/vnd.github+json", "user-agent": "agent-core" },
    });
    if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
    return (await response.json()) as T;
  }

  /** What finished while the agent was down; source_id absorbs what the webhook already brought. */
  async function catchUp() {
    if (!options.token) return;
    const since = Date.now() - (options.lookBackMs ?? 3600_000);
    for (const repo of options.repos ?? []) {
      try {
        for (const deployment of await api<Deployment[]>(`/repos/${repo}/deployments?per_page=10`)) {
          const [latest] = await api<Status[]>(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`);
          if (latest?.created_at && Date.parse(latest.created_at) >= since) ingest(row(repo, deployment, latest));
        }
      } catch (error) {
        console.error(`github: catch-up of ${repo} failed`, error);
      }
    }
  }

  return {
    handle,
    catchUp,
    async start() {
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
      void catchUp();
    },
    async stop() {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },
  };
}
