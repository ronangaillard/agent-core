import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeBrain } from "./claude.ts";
import { httpTools, type HttpApiConfig } from "./http.ts";
import { mcpTools, type McpServerConfig } from "./mcp.ts";
import { StatusFeed, statusServer, type StatusSink } from "./status.ts";
import { emailConnector } from "./connectors/email.ts";
import { githubConnector } from "./connectors/github.ts";
import { debugServer } from "./debug.ts";
import { slackConnector } from "./connectors/slack.ts";
import { Core, defaultConfig } from "./core.ts";
import { openDb } from "./db.ts";
import { historyTools } from "./history.ts";
import { Memory } from "./memory.ts";
import { DEFAULT_PROMPTS, Prompts } from "./prompts.ts";
import { ownerCommands } from "./owner.ts";
import { palsPresence } from "./pals.ts";
import { apercuWorkshop } from "./runners/apercu.ts";
import { claudeCodeRunner, tokensFromEnv } from "./runners/claude-code.ts";
import { Store } from "./store.ts";
import type { Mode, Rule } from "./types.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const ownerId = required("OWNER_SLACK_ID");
/** AGENT_PROMPTS: the folder of the editable prompts, one Markdown file each, written with their defaults if missing. */
const promptsDir = process.env.AGENT_PROMPTS ?? "data/prompts";
const personaFile = process.env.AGENT_PERSONA ?? join(promptsDir, "persona.md");
const prompts = new Prompts(promptsDir, { persona: personaFile });
const persona = existsSync(personaFile) ? readFileSync(personaFile, "utf8") : DEFAULT_PROMPTS.persona!;
const ownerChannel = process.env.AGENT_OWNER_CHANNEL;
const userToken = process.env.SLACK_USER_TOKEN;
const executable = process.env.CLAUDE_CODE_EXECUTABLE ? { executable: process.env.CLAUDE_CODE_EXECUTABLE } : {};

/** AGENT_MODES: a JSON object, mode_key → mode, e.g. {"slack:C0123":"triage"}. */
const modes = JSON.parse(process.env.AGENT_MODES ?? "{}") as Record<string, Mode>;
/** AGENT_PRIVACY=off: every conversation recalls everything said elsewhere, private or not (one trusted team). */
const privacy = process.env.AGENT_PRIVACY !== "off";

/** AGENT_DESTINATIONS: where the send tool may post, e.g. {"team":{"channel":"C0123","rules":["all"]}}. */
const destinations = Object.fromEntries(
  Object.entries(JSON.parse(process.env.AGENT_DESTINATIONS ?? "{}") as Record<string, { channel: string; rules?: Rule[] }>).map(([name, d]) => [
    name,
    { address: { connector: "slack", conversation: d.channel, thread: "main" }, rules: d.rules ?? ["owner"] },
  ]),
);

/** E-mail through Resend: off unless its key, webhook secret and address are set. */
const email =
  process.env.RESEND_API_KEY && process.env.RESEND_WEBHOOK_SECRET && process.env.AGENT_EMAIL
    ? emailConnector({
        apiKey: process.env.RESEND_API_KEY,
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
        port: Number(process.env.EMAIL_WEBHOOK_PORT ?? 8788),
        address: process.env.AGENT_EMAIL,
        name: process.env.AGENT_NAME ?? "Agent",
        allowedDomains: (process.env.EMAIL_ALLOWED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
      })
    : undefined;

/**
 * Code tasks: off unless a GitHub token, the repositories and steve-apercu's workshop are set. Each task's Claude Code
 * session runs whole in the workshop (a container per copy), with the token of its repository's owner
 * (GITHUB_TOKEN_<OWNER>, else GITHUB_TOKEN): fine-grained, limited to the task repositories.
 */
const repos = (process.env.AGENT_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
const workshop =
  process.env.STEVE_APERCU_URL && process.env.STEVE_APERCU_TOKEN ? apercuWorkshop({ url: process.env.STEVE_APERCU_URL, token: process.env.STEVE_APERCU_TOKEN }) : undefined;
const runner =
  process.env.GITHUB_TOKEN && repos.length && workshop
    ? claudeCodeRunner({
        workspace: process.env.AGENT_WORKSPACE ?? "data/workspace",
        githubToken: process.env.GITHUB_TOKEN,
        githubTokens: tokensFromEnv(process.env),
        persona,
        prompts,
        name: process.env.AGENT_NAME ?? "Agent",
        // Code tasks think harder than replies: opus unless CLAUDE_TASK_MODEL says otherwise.
        model: process.env.CLAUDE_TASK_MODEL ?? "opus",
        workshop,
      })
    : undefined;

/**
 * GitHub, off without a webhook secret: a conversation per repository where finished deployments and watched workflow
 * runs (GITHUB_WORKFLOWS, by name, on the default branch) arrive. Nobody reads there: the agent acts with its tools, with
 * the owner's rights (he configured this source), e.g. telling someone in a direct message, as its memory says.
 */
const github = process.env.GITHUB_WEBHOOK_SECRET
  ? githubConnector({
      secret: process.env.GITHUB_WEBHOOK_SECRET,
      port: Number(process.env.GITHUB_WEBHOOK_PORT ?? 8787),
      ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
      repos: (process.env.GITHUB_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean),
      workflows: (process.env.GITHUB_WORKFLOWS ?? "").split(",").map((w) => w.trim()).filter(Boolean),
      onPullRequestClosed: (repo, pr, merged) => core.pullRequestClosed(repo, pr, merged),
    })
  : undefined;

const dbPath = process.env.AGENT_DB ?? "data/agent.db";
const db = openDb(dbPath);

/** AGENT_SHELVES: read-only folders the memory tools also read, e.g. {"code":"/app/src"} (the agent's own source). */
const shelves = JSON.parse(process.env.AGENT_SHELVES ?? "{}") as Record<string, string>;
/** AGENT_MEMORY_WRITERS=all: every conversation writes the memory (common/), not only the owner's. */
const memory = new Memory(process.env.AGENT_MEMORY ?? "data/memory", shelves, process.env.AGENT_MEMORY_WRITERS === "all" ? "all" : "owner");

/**
 * AGENT_MCP_SERVERS: remote MCP servers whose tools the agent gets, all of them, with their token's rights, e.g.
 * {"notion":{"url":"https://mcp.notion.com/mcp","headers":{"Authorization":"Bearer ${NOTION_MCP_TOKEN}"}}}.
 */
const mcpServers = JSON.parse(process.env.AGENT_MCP_SERVERS ?? "{}") as Record<string, McpServerConfig>;
const mcp = await mcpTools(mcpServers, { authDir: process.env.AGENT_MCP_AUTH ?? "data/mcp-auth" });

/**
 * AGENT_HTTP_APIS: the HTTP APIs the agent may call (http_get, http_send), and only those, e.g.
 * {"pals":{"url":"https://pals.example.com","description":"the Pals Office","headers":{"Authorization":"Bearer ${PALS_TOKEN}"}}}.
 */
const http = httpTools(JSON.parse(process.env.AGENT_HTTP_APIS ?? "{}") as Record<string, HttpApiConfig>);

/**
 * The web view: the tables (read-only), and the prompts and the memory (read and edited). Off unless both are set:
 * it shows private conversations and changes what the agent is told.
 */
const debug =
  process.env.AGENT_DEBUG_PORT && process.env.AGENT_DEBUG_PASSWORD
    ? debugServer({ dbPath, port: Number(process.env.AGENT_DEBUG_PORT), password: process.env.AGENT_DEBUG_PASSWORD, folders: { prompts: promptsDir, memory: memory.root } })
    : undefined;

const core = new Core({
  db,
  connectors: [
    slackConnector({ botToken: required("SLACK_BOT_TOKEN"), appToken: required("SLACK_APP_TOKEN"), ownerId, ...(userToken ? { userToken } : {}) }),
    ...(email ? [email] : []),
    ...(github ? [github] : []),
  ],
  commands: ownerCommands(),
  ...(runner ? { runner } : {}),
  brain: claudeBrain({ ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}), ...executable }),
  gate: claudeBrain({ model: process.env.CLAUDE_GATE_MODEL ?? "haiku", ...executable }),
  memory,
  prompts,
  tools: [...memory.tools(), ...historyTools(new Store(db), { ownerId, on: privacy }), ...mcp, ...http],
  config: {
    ...defaultConfig,
    ownerId,
    persona,
    modes,
    privacy,
    destinations,
    repos,
    ...(process.env.AGENT_OWNER_NAME ? { ownerName: process.env.AGENT_OWNER_NAME } : {}),
    // AGENT_OWNER_DRAFTS=on: a mention of the owner gets a reply drafted in his name, to approve. Off by default: the
    // agent does not answer for him unasked. It needs his token, and his DM to approve them.
    draftForOwner: process.env.AGENT_OWNER_DRAFTS === "on" && Boolean(userToken && ownerChannel),
    ownerSources: github ? ["github"] : [],
    ...(ownerChannel ? { ownerAddress: { connector: "slack", conversation: ownerChannel, thread: "main" } } : {}),
  },
});

/** What the agent is doing now, folded once for those who show it: the small screen, the Pals Office. */
const feed = new StatusFeed(core.store);

const sinks: StatusSink[] = [];
// The live status for a small screen (devices/m5stick), off unless both are set: GET /status, Server-Sent Events.
if (process.env.AGENT_STATUS_PORT && process.env.AGENT_STATUS_TOKEN)
  sinks.push(statusServer({ feed, port: Number(process.env.AGENT_STATUS_PORT), token: process.env.AGENT_STATUS_TOKEN }));
// The agent in the Pals Office, off unless both are set.
if (process.env.PALS_URL && process.env.PALS_TOKEN) sinks.push(palsPresence({ feed, url: process.env.PALS_URL, token: process.env.PALS_TOKEN }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void Promise.all([core.stop(), debug?.stop(), ...sinks.map((sink) => sink.stop())]).finally(() => process.exit(0));
  });
}

await core.start();
// The tasks still waiting on a pull request: closed while down, they are settled now (once, at start).
if (github && process.env.GITHUB_TOKEN) {
  for (const task of core.store.tasksWith("waiting")) {
    if (!task.pr) continue;
    try {
      const state = await github.pullRequest(task.repo, task.pr);
      if (state.closed) core.pullRequestClosed(task.repo, task.pr, state.merged);
    } catch (error) {
      console.error(`github: PR #${task.pr} of task #${task.id} not read`, error);
    }
  }
}
await debug?.start();
console.log("agent-core started");
