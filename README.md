# agent-core

A generic core for a conversational agent. Nothing in it is specific to one agent: the persona, the owner and the
tokens come from the environment.

## Principles

- **Durable state in SQLite**: `inbox` and `outbox` carry the state (a status), `events` keeps the history,
  append-only, `reminders` holds what is due later. Every status change writes its event in the same transaction.
- **No polling**: an in-memory `wake()` after every write, a single timer on the next due date, one pass at start.
- **One `respond()` at a time per thread**: the thread stays locked until its reply is delivered.
- **Rights come from code** (`scopeOf`), never from the model.
- **Never a double post**: an interrupted delivery (crash, timeout, ambiguous error) is never sent again; it goes
  `dead` with an alert to the owner.

## Layout

| File | Role |
|---|---|
| `src/types.ts` | The contract: `Address`, `InboxRow`, `Post`, `Connector`, `Form`, `Brain` |
| `src/db.ts` | The SQLite schema and transactions |
| `src/store.ts` | Every read and write of the tables |
| `src/core.ts` | The inbound queue (lot, settle, attempts, backoff), `respond()`, the outbound queue and delivery, the scheduler, `send()` |
| `src/act.ts` | The tools that act: `send`, `set_reminder`, `list_reminders`, `cancel_reminder` |
| `src/claude.ts` | The model through the Claude Agent SDK, tools as an in-process MCP server |
| `src/access.ts` | Rights: which tools a scope gets, checked again when a tool runs |
| `src/memory.ts` | Markdown memory: `common/` everywhere, `private/` only with the owner in private |
| `src/history.ts` | The `<elsewhere>` digest and the conversation search, on `events` |
| `src/connectors/slack.ts` | The Slack connector (Socket Mode) |
| `src/sources/github.ts` | GitHub deployments: a signed webhook, and a pass at start for what was missed |
| `src/main.ts` | Startup |

## Run

```bash
npm install
cp .env.example .env   # then fill it in
npm start
```

Variables: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OWNER_SLACK_ID` (required); `AGENT_DB` (default `data/agent.db`),
`AGENT_PERSONA` (default `persona.md`), `AGENT_MEMORY` (default `data/memory`), `AGENT_ALERT_CHANNEL` (the owner's
DM, for alerts), `AGENT_MODES` (JSON, mode_key → `mention` | `mention-sticky` | `triage`), `CLAUDE_MODEL`,
`CLAUDE_GATE_MODEL` (triage, default `haiku`), `CLAUDE_CODE_EXECUTABLE`, `AGENT_DESTINATIONS` (JSON, name →
`{"channel": "C…", "rules": ["all"]}`, owner-only by default).

GitHub deployments (off unless both are set): `GITHUB_WEBHOOK_SECRET`, `GITHUB_DEPLOY_CHANNEL`; optional
`GITHUB_WEBHOOK_PORT` (default 8787), `GITHUB_TOKEN` and `GITHUB_REPOS` (comma-separated, for the pass at start).
The webhook takes the `deployment_status` event; only final states count, once per deployment.

Do not run it on the same Slack app as another agent: both would answer.

## Tests

```bash
npm test
```

The tests simulate a crash at every transition (before handling, during `respond()`, while delivering, after
drafting), a SIGTERM, transient and durable errors, a burst, the per-thread lock and the limit of three concurrent
`respond()`.

## Status

Step 1, done: the durable core end to end, the Slack connector (a DM gets a reply).

Step 2, done: engagement modes per place (`mention`, `mention-sticky`, `triage` by a cheap model, outside the
`respond()` quota), the bot-to-bot cap (bot or system messages in a row within an hour, one "I'm stopping" post,
reset by a human), the catch-up from a cursor frozen before connecting and at disconnection, tools with rules
checked twice, the Markdown memory, the `<elsewhere>` digest and the conversation search with the privacy rule.

Step 3, done:
- `send` to a named destination (with its rules), or for the owner to a person (`resolve`) or to the thread of a
  message (`message:<id>`, same privacy rule as the digest). The idempotency key and an `acted` event are written
  with the outbox row before the call: the same send never leaves twice; an ambiguous failure is reported as
  "status unknown" and never retried; a definite failure frees the key.
- Reminders scoped to the conversation (at most 5): firing is one transaction (a system row whose `source_id` is
  `reminder:<id>:<due_at>`, then the reminder re-armed or deleted); a repeating reminder missed while down fires
  once. Jobs: named functions on the same scheduler, invisible to the tools. One timer for everything.
- The prompt carries what the agent already did from the conversation, and the text of system events.
- The GitHub deployment source.

Not yet: the e-mail connector and `held`, the owner's path (commands, drafts, polls), code tasks.
