# agent-core

A generic core for a conversational agent. Nothing in it is specific to one agent: the persona, the owner and the
tokens come from the environment.

## Principles

- **Durable state in SQLite**: `inbox` and `outbox` carry the state (a status), `events` keeps the history,
  append-only, `reminders` holds what is due later. Every status change writes its event in the same transaction.
- **No polling**: an in-memory `wake()` after every write, a single timer on the next due date, one pass at start.
  Every wake runs the full pass (scheduler, inbound, outbound) before re-arming the timer; a timer that fires early
  waits the rest.
- **One `respond()` at a time per thread**: the thread stays locked until its reply is delivered.
- **Rights come from code** (`scopeOf`), never from the model.
- **Never a double post**: an interrupted delivery (crash, timeout, ambiguous error) is never sent again; it goes
  `dead` with an alert to the owner, written in the same transaction. A SIGTERM waits for the posts in flight.
- **Only the owner writes the memory**: what is in it comes up in every prompt as trusted.

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
| `src/memory.ts` | Markdown memory: `common/` everywhere, `private/` only with the owner in private; read-only shelves |
| `src/history.ts` | The `<elsewhere>` digest and the conversation search, on `events` |
| `src/tasks.ts` | Code tasks: the runner contract, `start_code_task`, the `<in_progress>` block |
| `src/runners/claude-code.ts` | The runner: a copy per task, a sandboxed Claude Code session, push and PR from this process |
| `src/owner.ts` | The owner's commands: `held`, `send <n>`, `send <n>: <text>`, `drop <n>`, `help` |
| `src/connectors/slack.ts` | The Slack connector (Socket Mode) |
| `src/connectors/email.ts` | The e-mail connector (Resend: signed webhook in, API out) |
| `src/sources/github.ts` | GitHub deployments: a signed webhook, and a pass at start for what was missed |
| `src/main.ts` | Startup |

## Run

```bash
npm install
cp .env.example .env   # then fill it in
npm start
```

Variables: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OWNER_SLACK_ID` (required); `AGENT_DB` (default `data/agent.db`),
`AGENT_PERSONA` (default `persona.md`), `AGENT_MEMORY` (default `data/memory`), `AGENT_OWNER_CHANNEL` (the owner's
DM: alerts, and what waits for the owner), `AGENT_OWNER_NAME`, `SLACK_USER_TOKEN` (the owner's token: with
`AGENT_OWNER_CHANNEL`, turns on drafts in his name), `AGENT_MODES` (JSON, mode_key → `mention` | `mention-sticky` | `triage`), `CLAUDE_MODEL`,
`CLAUDE_GATE_MODEL` (triage, default `haiku`), `CLAUDE_CODE_EXECUTABLE`, `AGENT_DESTINATIONS` (JSON, name →
`{"channel": "C…", "rules": ["all"]}`, owner-only by default), `AGENT_SHELVES` (JSON, name → folder: read-only
folders the memory tools also read, for everyone, never written nor put in the prompt; e.g. `{"code":"/app/src"}`
lets the agent read its own source, the version running).

GitHub deployments (off unless both are set): `GITHUB_WEBHOOK_SECRET`, `GITHUB_DEPLOY_CHANNEL`; optional
`GITHUB_WEBHOOK_PORT` (default 8787), `GITHUB_TOKEN` and `GITHUB_REPOS` (comma-separated, for the pass at start).
The webhook takes the `deployment_status` event; only final states count, once per deployment.

Code tasks (off unless both are set): `GITHUB_TOKEN`, `AGENT_REPOS` (comma-separated, the first is the default);
`AGENT_WORKSPACE` (default `data/workspace`). The session's terminal runs in Claude Code's sandbox (on Linux it needs
`bubblewrap`): it writes only in the task's copy and reaches only package registries.

E-mail (off unless the first three are set): `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `AGENT_EMAIL`;
`AGENT_NAME` (the signature), `EMAIL_WEBHOOK_PORT` (default 8788), `EMAIL_ALLOWED_DOMAINS`
(comma-separated). The Resend webhook takes the `email.received` event.

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

Step 4, done:
- `held`: a reply the form keeps for the owner (an e-mail the agent was not sure of, a draft in his name) never
  leaves alone and never locks its thread; a newer one in the thread replaces it. The owner is told in the same
  transaction, in his DM, with the draft, the form's note and how to act on it.
- The owner's commands, matched by code on the rows of his private conversation before anything else (outcome
  `intercepted`, no model call): list, send as is or edited, drop. Slack only: an e-mail never gets the owner's
  scope nor a command (DMARC vouches for a domain, not a mailbox).
- Drafts in the owner's name: a human mentions him where the agent would not speak → the agent writes his reply,
  with no acting tools, held; once he sends it, it is posted with his Slack token and never counts as the agent's.
- The e-mail connector: a Svix-signed webhook, a catch-up through the API, only allowed domains with DMARC passing
  (a Reply-To outside them is not followed), a thread per started mail and sender (the first Message-ID of
  References, which the sender sets, plus who writes: never the subject), the sender's address as author (never
  the owner's scope or identity, even from his address), replies in the e-mail thread (In-Reply-To, References), a
  form where the agent says whether it is sure.
- Polls need no code of their own: `send` to people, and a destination for the owner.

Step 5, done: code tasks (`tasks` table: one copy, one branch, one PR each).
- `start_code_task`: with no number, it continues the only task open in the conversation, or starts one; with a
  number, it continues that task from anywhere it is visible (same privacy rule as the digest), and reports in the
  task's own conversation. A running task is changed only by its requester or the owner; the rights of a
  continuation are the lesser of the task's and the requester's. One task runs at a time; a replaced run says
  nothing.
- Reports and progress notes (at most 5, spaced out) go to the task's conversation as outbox `report` rows; a failure
  is a one-line "blocked" report and an alert. A task a restart cut runs again (twice at most), then is abandoned
  with a word.
- `<in_progress>` in every prompt: open tasks and those done within 7 days, upcoming reminders, and for the owner
  what waits for him.
- The Claude Code runner: the token stays in this process, in a vault (a bare repository per task, outside the
  workspace, which the session can neither read nor write). The copy is cloned from the vault and never trusted:
  pushing fetches the task's branch from the copy into the vault (no hook, no fsmonitor) and pushes from there to the
  remote named by code; the token goes through that command's environment, never its arguments. Commits someone else
  pushed to the branch reach the session as a bundle to merge. The session gets file tools inside its copy except
  `.git` (any case, symlinks followed), a sandboxed terminal that cannot read the agent's folder or home, and
  `progress`, `push_branch`, `open_pr`; everything else is refused.

After two reviews: the catch-up cursor is stored and moves only when a pass completes; a reconnection during a pass
runs another one after it; a failed pass is tried again on the one timer, five times at most, then an alert; a
channel Slack refuses is skipped; a live event not read for a passing reason owes a pass. A failure before a lot is
fixed waits a backoff and counts against the row that failed, it never spins. `send` keys the n-th send to a place
in a lot, so a re-run, even reworded, sends nothing twice; a SIGTERM waits for sends in flight too. A job that
ingests cannot make another one run twice. a draft in the owner's name or a held reply shows only to the owner;
a task is changed by its requester, the owner or in its own conversation, and a private conversation is not handed
to a task that reports elsewhere; a draft gets no tool with an effect (`effect` on `ToolDef`); search results carry
`message:<id>` for `send`.

After a debate between the agent and another one, checked against the code: a model call (respond, the triage
gate) has a deadline (`brainTimeoutMs`, 10 min): past it, the call is aborted (the Claude Code process too) and it is
a passing failure, so a hung call never holds a thread and a slot for good; the Slack catch-up reads thread roots 7
days before its cursor, so a reply posted while away in an older thread is caught up; memory writes are atomic
(temp file, then rename).

Known limits: a permission the session lacks is refused, not asked to the owner; a merged PR leaves its task
`waiting`; the owner's own DMs with colleagues (his user token's events) are not read; an e-mail's `read()` gives the
e-mail itself (its quoted history included); an e-mail thread with several people is one conversation per sender,
so two of them answering at once can each get a reply; a reply while away in a thread older than 7 days is not
caught up; a Slack blip shorter than `catchUpAfterMs` is not caught up;
one live event not read for a passing reason costs a full catch-up pass.
