import { existsSync, readFileSync } from "node:fs";
import { claudeBrain } from "./claude.ts";
import { emailConnector } from "./connectors/email.ts";
import { debugServer } from "./debug.ts";
import { slackConnector } from "./connectors/slack.ts";
import { Core, defaultConfig } from "./core.ts";
import { openDb } from "./db.ts";
import { historyTools } from "./history.ts";
import { Memory } from "./memory.ts";
import { ownerCommands } from "./owner.ts";
import { githubSource } from "./sources/github.ts";
import { claudeCodeRunner } from "./runners/claude-code.ts";
import { Store } from "./store.ts";
import type { Mode, Rule } from "./types.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const ownerId = required("OWNER_SLACK_ID");
const personaFile = process.env.AGENT_PERSONA ?? "persona.md";
const persona = existsSync(personaFile) ? readFileSync(personaFile, "utf8") : "You are an agent chatting on Slack.";
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

/** Code tasks: off unless a GitHub token and the repositories are set. */
const repos = (process.env.AGENT_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
const runner =
  process.env.GITHUB_TOKEN && repos.length
    ? claudeCodeRunner({
        workspace: process.env.AGENT_WORKSPACE ?? "data/workspace",
        githubToken: process.env.GITHUB_TOKEN,
        persona,
        name: process.env.AGENT_NAME ?? "Agent",
        ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
        ...executable,
      })
    : undefined;

const dbPath = process.env.AGENT_DB ?? "data/agent.db";
const db = openDb(dbPath);

/** A read-only web view of the tables: off unless both are set (the tables hold private conversations). */
const debug =
  process.env.AGENT_DEBUG_PORT && process.env.AGENT_DEBUG_PASSWORD
    ? debugServer({ dbPath, port: Number(process.env.AGENT_DEBUG_PORT), password: process.env.AGENT_DEBUG_PASSWORD })
    : undefined;
/** AGENT_SHELVES: read-only folders the memory tools also read, e.g. {"code":"/app/src"} (the agent's own source). */
const shelves = JSON.parse(process.env.AGENT_SHELVES ?? "{}") as Record<string, string>;
const memory = new Memory(process.env.AGENT_MEMORY ?? "data/memory", shelves);

const core = new Core({
  db,
  connectors: [
    slackConnector({ botToken: required("SLACK_BOT_TOKEN"), appToken: required("SLACK_APP_TOKEN"), ownerId, ...(userToken ? { userToken } : {}) }),
    ...(email ? [email] : []),
  ],
  commands: ownerCommands(),
  ...(runner ? { runner } : {}),
  brain: claudeBrain({ ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}), ...executable }),
  gate: claudeBrain({ model: process.env.CLAUDE_GATE_MODEL ?? "haiku", ...executable }),
  memory,
  tools: [...memory.tools(), ...historyTools(new Store(db), { ownerId, on: privacy })],
  config: {
    ...defaultConfig,
    ownerId,
    persona,
    modes,
    privacy,
    destinations,
    repos,
    ...(process.env.AGENT_OWNER_NAME ? { ownerName: process.env.AGENT_OWNER_NAME } : {}),
    // Drafts in the owner's name need his token, and his DM to approve them.
    draftForOwner: Boolean(userToken && ownerChannel),
    ...(ownerChannel ? { ownerAddress: { connector: "slack", conversation: ownerChannel, thread: "main" } } : {}),
  },
});

/** GitHub deployments, announced in a channel; off without a webhook secret. */
const github =
  process.env.GITHUB_WEBHOOK_SECRET && process.env.GITHUB_DEPLOY_CHANNEL
    ? githubSource(core, {
        secret: process.env.GITHUB_WEBHOOK_SECRET,
        port: Number(process.env.GITHUB_WEBHOOK_PORT ?? 8787),
        address: { connector: "slack", conversation: process.env.GITHUB_DEPLOY_CHANNEL, thread: "main" },
        ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
        repos: (process.env.GITHUB_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean),
      })
    : undefined;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void Promise.all([core.stop(), github?.stop(), debug?.stop()]).finally(() => process.exit(0));
  });
}

await core.start();
await github?.start();
await debug?.start();
console.log("agent-core started");
