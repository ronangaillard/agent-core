# agent-core

A generic core for a conversational agent. Nothing in it is specific to one agent: the persona, the owner and the
tokens come from the environment.

Architecture diagrams: [docs/](docs/index.html) (published at https://ronangaillard.github.io/agent-core/).

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
- **Only the owner writes the memory** by default: what is in it comes up in every prompt as trusted (`AGENT_MEMORY_WRITERS=all` lets the agent learn from anyone, at that risk; the persona stays out of reach).

## Layout

| File | Role |
|---|---|
| `src/types.ts` | The contract: `Address`, `InboxRow`, `Post`, `Connector`, `Form`, `Brain` |
| `src/db.ts` | The SQLite schema and transactions |
| `src/store.ts` | Every read and write of the tables |
| `src/core.ts` | The inbound queue (lot, settle, attempts, backoff), `respond()`, the outbound queue and delivery, the scheduler, `send()` |
| `src/act.ts` | The tools that act or reach elsewhere: `send`, `read_conversation`, `search_messages`, `open_file`, `set_reminder`, `list_reminders`, `cancel_reminder` |
| `src/claude.ts` | The model through the Claude Agent SDK, tools as an in-process MCP server |
| `src/access.ts` | Rights: which tools a scope gets, checked again when a tool runs |
| `src/memory.ts` | Markdown memory: `common/` everywhere, `private/` only with the owner in private; read-only shelves; `memory_list`, `memory_read`, `memory_write` |
| `src/prompts.ts` | Every text the agent is prompted with, one editable Markdown file each, read at every use |
| `src/mcp.ts` | Remote MCP servers (`AGENT_MCP_SERVERS`, e.g. Notion): all their tools as the agent's own, bound by rules and traced; a tool not marked read-only is an effect |
| `src/http.ts` | `http_get` · `http_send`: calls to the APIs listed in `AGENT_HTTP_APIS` only, the token added by the code; sending is an effect |
| `src/mcp-auth.ts` · `src/mcp-login.ts` | An MCP server's OAuth sign-in: done once by hand in two steps, kept in `AGENT_MCP_AUTH/<name>.json`, refreshed by the client |
| `src/status.ts` | The live status (`idle`, `received`, `thinking`, `tool`, `writing`, `coding`) folded from the activity, served as Server-Sent Events on `GET /status` |
| `src/pals.ts` | The agent in the Pals Office: the status turned into presence signals (`prompt`, `stop`, `heartbeat`, `session_end`) |
| `devices/m5stick/` | An M5StickC Plus2 that shows the status: the agent's face from its profile picture, animated by state |
| `src/history.ts` | The `<elsewhere>` digest and `search_conversations`, on `events` |
| `src/tasks.ts` | Code tasks: the runner contract, `start_code_task`, `abandon_code_task`, the `<in_progress>` block |
| `src/runners/claude-code.ts` | The runner: a copy per task, its whole Claude Code session in the workshop, which pushes and opens the PR itself |
| `src/runners/apercu.ts` | steve-apercu's workshop: a fresh container per run, the session's output streamed line by line |
| `src/owner.ts` | The owner's commands: `held`, `send <n>`, `send <n>: <text>`, `drop <n>`, `help` |
| `src/connectors/slack.ts` | The Slack connector (Socket Mode) |
| `src/connectors/email.ts` | The e-mail connector (Resend: signed webhook in, API out) |
| `src/connectors/github.ts` | GitHub as a read-only connector: a conversation per repository, its finished deployments and watched workflow runs as events |
| `src/debug.ts` | A web view behind a password: the tables (read-only), the prompts and the memory (read and edited) |
| `src/main.ts` | Startup |

## Run

```bash
npm install
cp .env.example .env   # then fill it in
npm start
```

Variables: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OWNER_SLACK_ID` (required); `AGENT_DB` (default `data/agent.db`),
`AGENT_PROMPTS` (default `data/prompts`: the prompts, one Markdown file each, written with their defaults when
missing and read at every use, so an edit applies at the next message), `AGENT_PERSONA` (default `<AGENT_PROMPTS>/persona.md`), `AGENT_MEMORY` (default `data/memory`), `AGENT_OWNER_CHANNEL` (the owner's
DM: alerts, and what waits for the owner), `AGENT_OWNER_NAME`, `SLACK_USER_TOKEN` (the owner's token: posts
in his name, search), `AGENT_OWNER_DRAFTS` (`on`: a mention of the owner gets a reply drafted in his name, to approve;
needs `SLACK_USER_TOKEN` and `AGENT_OWNER_CHANNEL`; off by default), `AGENT_MODES` (JSON, mode_key → `mention` | `mention-sticky` | `triage`), `AGENT_MEMORY_WRITERS` (`all`: every conversation writes the
memory's `common/`, not only the owner's; the persona is never in it), `AGENT_PRIVACY` (`off`: every
conversation recalls everything said elsewhere, private or not; for one trusted team), `CLAUDE_MODEL`,
`CLAUDE_GATE_MODEL` (triage, default `haiku`), `CLAUDE_TASK_MODEL` (code tasks, default `opus`), `CLAUDE_CODE_EXECUTABLE`, `AGENT_DESTINATIONS` (JSON, name →
`{"channel": "C…", "rules": ["all"]}`, owner-only by default), `AGENT_DEBUG_PORT` and `AGENT_DEBUG_PASSWORD` (both, or no web view: the tables read-only, the
prompts and the memory read and edited; basic auth with user `debug`; it shows private conversations and changes what the
agent is told), `AGENT_SHELVES` (JSON, name → folder: read-only
folders the memory tools also read, for everyone, never written nor put in the prompt; e.g. `{"code":"/app/src"}`
lets the agent read its own source, the version running), `AGENT_MCP_SERVERS` (JSON, name → `{"url", "headers", "rules"}`:
remote MCP servers over streamable HTTP; all their tools, with the rights of their token, for everyone by default; `${VAR}`
in a header is read from the environment, so the token stays a secret; e.g.
`{"notion":{"url":"https://mcp.notion.com/mcp","headers":{"Authorization":"Bearer ${NOTION_MCP_TOKEN}"}}}`; a server
down at start is left out until the next restart; a tool the server does not mark read-only never goes to an owner draft).
With `"oauth": true` instead of a header, the agent signs in as a person (Notion: `{"notion":{"url":"https://mcp.notion.com/mcp","oauth":true}}`,
with that person's rights): `tsx src/mcp-login.ts notion` in the container prints the address to open, signed in to the
service; the browser then fails on `localhost:8976/callback?code=…`, and `tsx src/mcp-login.ts notion '<that address>'`
finishes. The tokens are kept in `AGENT_MCP_AUTH` (default `data/mcp-auth`, `/data/mcp-auth` in the image) and refreshed;
the tools load at the next start.

`AGENT_HTTP_APIS` (JSON, name → `{"url", "description", "headers", "rules"}`): the HTTP APIs the agent may call with
`http_get` and `http_send`, and no other; `${VAR}` in a header is read from the environment, so the model never sees the
token; the model gives an API name and a path, a path leaving the base URL is refused; e.g.
`{"pals":{"url":"https://pals.example.com","description":"the Pals Office","headers":{"Authorization":"Bearer ${PALS_TOKEN}"}}}`.

Live status (off unless both are set): `AGENT_STATUS_PORT` and `AGENT_STATUS_TOKEN`. `GET /status` with
`Authorization: Bearer <token>` streams Server-Sent Events: one `status` event at once, then one at each change,
`{"state", "detail", "tasks", "at"}`, and a comment every 25 s for proxies. The state is folded from every event the
store writes, plus two moments it does not write (a model or a tool starting); the detail is a tool's name or a
repository, never what a message says. A moment with nothing after it falls back to `idle` (or `coding` while a code
task runs) after 2 minutes; `received` lasts 4 seconds, then back to what a run under way was doing, or `idle`. Meant to be reached through a tunnel (Cloudflare) by `devices/m5stick`.

Pals Office (off unless `PALS_URL` and `PALS_TOKEN` are set): the same status, posted
as signals to `<url>/api/presence` with the pal token. Every moment is a `prompt` with a short status (`Lit un message
Slack`, `Utilise <tool>`, `Code sur <repo>`; never what a message says), a minute of `idle` a `stop`, a `heartbeat`
every 2 minutes, `session_end` on SIGTERM. A failed signal is logged, once per distinct error, and nothing else.

GitHub (off without `GITHUB_WEBHOOK_SECRET`): a connector of its own, read-only. Each repository is a conversation
(`github:<owner>/<repo>`) where events arrive, from a signed webhook (`GITHUB_WEBHOOK_PORT`, default 8787, any path)
and from the standard catch-up (`GITHUB_TOKEN`, `GITHUB_REPOS`): a `deployment_status` in a final state, once per
deployment; with `GITHUB_WORKFLOWS` (workflow names, e.g. `Deploy to production`), a watched workflow's run that ends
on the default branch (success, failure, timed out, startup failure; cancelled says nothing), once per run attempt.
An event's text holds only facts GitHub guarantees (ids, commit, states, logins, links), never free text written by
others; `read()` gives the repository's recent events. Nobody reads there: the form has no message and `deliver`
refuses, so the agent acts with its tools (GitHub's MCP server to read, `send` to tell someone) or does nothing, as
its memory says. Its events are private and act with the owner's rights (`ownerSources`: he configured this source);
a person named in `send` is found by the first connector that knows people (Slack).

Code tasks (off unless all are set): `GITHUB_TOKEN`, `AGENT_REPOS` (comma-separated, the first is the default),
`STEVE_APERCU_URL` and `STEVE_APERCU_TOKEN` (the workshop where each session runs); `GITHUB_TOKEN_<OWNER>` for
another owner's repositories (`GITHUB_TOKEN_ACME_LABS` for `acme-labs/…`), fine-grained, limited to the task
repositories (the session holds it); `AGENT_WORKSPACE` (default `data/workspace`); `CLAUDE_TASK_MODEL` (default `opus`).

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
checked twice, the Markdown memory, the `<elsewhere>` digest and the conversation search with the privacy rule (local times, `message:<id>` on
each line), and `read_conversation`, which reads the whole conversation of a `message:<id>` under the same rule.
`search_messages` (the owner's alone unless `AGENT_PRIVACY=off`, when a connector can `search`: Slack with `SLACK_USER_TOKEN` and `search:read`)
searches the whole workspace with the owner's rights; `read_conversation` reads a hit's conversation (`found:<n>`).
Trace: every tool call (`tool`: name, arguments, result, duration) and every model run (`run`: turns, cost, duration) is an event, seen in the web view. The prompt carries the clock (`Now:`) and each message its local time. A message asked of the agent (DM, mention) and given up after two failures gets a short `failed-reply` in its thread; the error goes into the `failed` event and the owner's alert. Slack threads are read paged (the root and the last 150 messages), with files, long pastes and attachments, mentions by name; `resolve` finds a person by name for `send`. A shared file shows as `[image: … · file:<id>]` and `open_file` fetches it (`files:read`): an image is shown to the model (a large one as its 1024 px thumbnail), a text file read.

Reactions: a `{ reaction }` post (an emoji on the message answered), from the reply's form or, in `triage` mode,
from the gate when the agent stays silent; only to a connector that `reacts` (Slack). An outbox row of its own kind,
written with the reply or the closing (never sent twice), never held nor in the owner's name, never an alert when lost.

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
  transaction, in his DM, with the draft, the form's note and how to act on it: buttons (Send, Drop) where the
  connector has them (Slack, in a direct message), the text commands always written too. A command offers its button (`Command.button`); on Slack a
  click is the clicker typing that command in that DM (in first), and the card then shows what was asked.
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
  nothing. With several repositories, a new task must name one (`repo`); with one, it is the default.
- `abandon_code_task`: stops a task for good (same rights as changing it); its run is cut, its copy and branch stay.
- A task with an open PR is `waiting`; GitHub's `pull_request` event (and a check at start) makes it `done` when
  merged, `abandoned` when closed. Once `done` or `abandoned`, its copy and its bare repository are removed.
- Only the end goes to the task's conversation (an outbox `report` row): nothing on the way, the step it is at is in
  `<in_progress>` for whoever asks; a failure
  is a one-line report and an alert, and the task is `failed`: still open, asking again resumes it. A task a restart
  cut runs again (twice at most), then fails with a word. A run asked again on a branch with no commit of its own
  starts over from the remote's default branch as it is now.
- `<in_progress>` in every prompt: open tasks and those done within 7 days, upcoming reminders, and for the owner
  what waits for him.
- The Claude Code runner: each task's session runs whole in steve-apercu's workshop (a rootless container per copy,
  only the copy mounted, egress through a proxy limited to package registries, GitHub and Anthropic's API), headless
  (`claude -p`, stream-json), on `CLAUDE_TASK_MODEL` (default `opus`), with the repository's own settings (CLAUDE.md,
  skills, hooks, agents) but none of its MCP servers and no web tools. It commits, pushes the task's branch and opens
  the PR itself, following the repository's procedure, with `gh` and the GitHub token of the repository's owner
  (`GITHUB_TOKEN_<OWNER>`, else `GITHUB_TOKEN`), fine-grained: limited to the task repositories. Its input (prompt,
  system prompt, schema) and its tokens reach it through the session's environment only, never through files this
  process would write into the copy. Its news is its todo list's item in progress; its end, a structured report; the
  PR it opened is found by its branch afterwards. This process clones the copy from its vault (a bare repository per
  task) and never runs git in a copy a session has had (it only fetches the branch out of it, no hook, no fsmonitor).
  Stopping a task closes its workshop, which stops the session.

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
