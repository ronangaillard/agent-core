import { existsSync, readFileSync } from "node:fs";
import { claudeBrain } from "./claude.ts";
import { slackConnector } from "./connectors/slack.ts";
import { Core, defaultConfig } from "./core.ts";
import { openDb } from "./db.ts";
import { historyTools } from "./history.ts";
import { Memory } from "./memory.ts";
import { Store } from "./store.ts";
import type { Mode } from "./types.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const ownerId = required("OWNER_SLACK_ID");
const personaFile = process.env.AGENT_PERSONA ?? "persona.md";
const persona = existsSync(personaFile) ? readFileSync(personaFile, "utf8") : "You are an agent chatting on Slack.";
const alertChannel = process.env.AGENT_ALERT_CHANNEL;
const executable = process.env.CLAUDE_CODE_EXECUTABLE ? { executable: process.env.CLAUDE_CODE_EXECUTABLE } : {};

/** AGENT_MODES: a JSON object, mode_key → mode, e.g. {"slack:C0123":"triage"}. */
const modes = JSON.parse(process.env.AGENT_MODES ?? "{}") as Record<string, Mode>;

const db = openDb(process.env.AGENT_DB ?? "data/agent.db");
const memory = new Memory(process.env.AGENT_MEMORY ?? "data/memory");

const core = new Core({
  db,
  connectors: [slackConnector({ botToken: required("SLACK_BOT_TOKEN"), appToken: required("SLACK_APP_TOKEN"), ownerId })],
  brain: claudeBrain({ ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}), ...executable }),
  gate: claudeBrain({ model: process.env.CLAUDE_GATE_MODEL ?? "haiku", ...executable }),
  memory,
  tools: [...memory.tools(), ...historyTools(new Store(db), ownerId)],
  config: {
    ...defaultConfig,
    ownerId,
    persona,
    modes,
    ...(alertChannel ? { alertAddress: { connector: "slack", conversation: alertChannel, thread: "main" } } : {}),
  },
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void core.stop().finally(() => process.exit(0));
  });
}

await core.start();
console.log("agent-core started");
