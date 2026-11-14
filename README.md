# agent-core

A generic core for a conversational agent. Nothing in it is specific to one agent: the persona, the owner and the
tokens come from the environment.

## Principles

- **Durable state in SQLite**: `inbox` and `outbox` carry the state (a status), `events` keeps the history,
  append-only. Every status change writes its event in the same transaction.
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
| `src/store.ts` | Every read and write of the three tables |
| `src/core.ts` | The inbound queue (lot, settle, attempts, backoff), `respond()`, the outbound queue and delivery |
| `src/claude.ts` | The model through the Claude Agent SDK (step 1: no tools) |
| `src/connectors/slack.ts` | The Slack connector (Socket Mode) |
| `src/main.ts` | Startup |

## Run

```bash
npm install
cp .env.example .env   # then fill it in
npm start
```

Variables: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OWNER_SLACK_ID` (required); `AGENT_DB` (default `data/agent.db`),
`AGENT_PERSONA` (default `persona.md`), `AGENT_ALERT_CHANNEL` (the owner's DM, for alerts), `CLAUDE_MODEL`,
`CLAUDE_CODE_EXECUTABLE`.

Do not run it on the same Slack app as another agent: both would answer.

## Tests

```bash
npm test
```

The tests simulate a crash at every transition (before handling, during `respond()`, while delivering, after
drafting), a SIGTERM, transient and durable errors, a burst, the per-thread lock and the limit of three concurrent
`respond()`.

## Step 1: done and not yet done

Done: the durable core end to end, a `respond()` without tools, the Slack connector (a DM gets a reply).

Not yet: per-channel engagement modes and the bot-to-bot cap, Slack catch-up, tools and `ACCESS`, memory, digest,
reminders and scheduler, GitHub sources, the e-mail connector and `held`, the owner's path, code tasks.
