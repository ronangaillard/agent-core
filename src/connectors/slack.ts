import bolt from "@slack/bolt";
import { z } from "zod";
import { TransientError, type Address, type Connector, type DeliverResult, type InboxRow, type Post, type Thread } from "../types.ts";

const { App, SocketModeReceiver, webApi } = bolt;

/** Slack saying the bot is not, or no longer, in this channel. */
const LEFT = new Set(["not_in_channel", "channel_not_found", "is_archived"]);
export const leftChannel = (error: unknown) => {
  const e = error as { code?: string; data?: { error?: string } };
  return e.code === "slack_webapi_platform_error" && LEFT.has(e.data?.error ?? "");
};

/** A read that failed for a reason that passes (rate limit, 5xx, network): the core waits and retries. */
function readError(error: unknown): unknown {
  const e = error as { code?: string; statusCode?: number; message?: string };
  const passing =
    e.code === "slack_webapi_rate_limited_error" || e.code === "slack_webapi_request_error" || (e.code === "slack_webapi_http_error" && (e.statusCode ?? 0) >= 500);
  return passing ? new TransientError(e.message ?? String(error)) : error;
}

/** The fields of a Slack message event the connector reads. */
type SlackMessage = {
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  /** Shared files and long pastes (snippets): their name, and the start of their text. */
  files?: { name?: string; title?: string; preview?: string }[];
  /** Unfurls and bots' attachments. */
  attachments?: { pretext?: string; title?: string; text?: string; fallback?: string }[];
};

/** A thread is read whole up to the message (paged), the model gets its last messages. */
const THREAD_PAGES = 10;
const THREAD_KEEP = 150;
const DM_KEEP = 60;

/** Message subtypes that are real messages; edits, joins, deletions… are not. */
const SPOKEN = new Set([undefined, "file_share", "bot_message", "thread_broadcast"]);

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** Slack's markup → plain text: mentions by name, channels and links by their label, entities decoded. */
export function unslack(text: string, name: (id: string) => string): string {
  return text
    .replace(MENTION, (_, id: string) => `@${name(id)}`)
    .replace(/<#C[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)[^>]*>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const isoOf = (ts: string) => new Date(Number(ts) * 1000).toISOString();

/**
 * Slack through Socket Mode. The membership cache is filled at start with the bot token; a miss costs one call.
 * A conversation the bot is not in never becomes a row (the owner's DMs with others included).
 */
export function slackConnector(options: {
  botToken: string;
  appToken: string;
  ownerId: string;
  /** To post the owner's approved drafts in his name. */
  userToken?: string;
  /** The catch-up reads thread roots this far before its cursor, for the replies posted while away (default 7). */
  threadLookbackDays?: number;
}): Connector {
  const receiver = new SocketModeReceiver({ appToken: options.appToken });
  // No silent retries in the client: a retried post is a possible double. The core decides.
  const app = new App({ token: options.botToken, receiver, clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true } });
  const client = app.client;
  // Reads may wait out a rate limit and retry (a read twice harms nothing); posts never do.
  const retries = { retries: 5, factor: 2, minTimeout: 1000, maxTimeout: 30_000 };
  const reader = new webApi.WebClient(options.botToken, { retryConfig: retries });
  // The owner's eyes: search, and reading what search found where the bot is not.
  const ownerReader = options.userToken ? new webApi.WebClient(options.userToken, { retryConfig: retries }) : undefined;
  const self = { userId: "", botId: "" };
  const member = new Map<string, boolean>();
  const secret = new Map<string, boolean>();
  const names = new Map<string, string>();
  const channelNames = new Map<string, string>();
  const connected: (() => void)[] = [];
  const disconnected: (() => void)[] = [];

  const remember = (channel: { id?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_member?: boolean; name?: string }) => {
    if (!channel.id) return;
    member.set(channel.id, Boolean(channel.is_im || channel.is_member));
    secret.set(channel.id, Boolean(channel.is_im || channel.is_mpim || channel.is_private));
    if (channel.name) channelNames.set(channel.id, channel.name);
  };

  async function loadMembership() {
    let cursor: string | undefined;
    do {
      const page = await reader.conversations.list({ types: "public_channel,private_channel,mpim,im", limit: 1000, exclude_archived: true, ...(cursor ? { cursor } : {}) });
      for (const channel of page.channels ?? []) remember(channel);
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  async function isMember(channel: string): Promise<boolean> {
    const known = member.get(channel);
    if (known !== undefined) return known;
    try {
      const info = await reader.conversations.info({ channel });
      if (info.channel) remember(info.channel);
      return member.get(channel) ?? false;
    } catch (error) {
      // Not known for a reason that passes: the event is not dropped silently, the core owes a catch-up.
      const read = readError(error);
      if (read instanceof TransientError) throw read;
      return false;
    }
  }

  /** The workspace's people, loaded once (names change rarely; a restart reloads them). */
  let people: { id: string; names: string[] }[] | undefined;
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  async function directory() {
    if (people) return people;
    const found: { id: string; names: string[] }[] = [];
    let cursor: string | undefined;
    do {
      const page = await reader.users.list({ limit: 500, ...(cursor ? { cursor } : {}) });
      for (const u of page.members ?? []) {
        if (!u.id || u.deleted || u.is_bot) continue;
        found.push({ id: u.id, names: [u.profile?.display_name, u.real_name, u.name].filter((n): n is string => Boolean(n)).map(fold) });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    people = found;
    return found;
  }

  async function nameOf(user?: string): Promise<string> {
    if (!user) return "?";
    const known = names.get(user);
    if (known) return known;
    try {
      const info = await reader.users.info({ user });
      const name = info.user?.profile?.display_name || info.user?.real_name || info.user?.name || user;
      names.set(user, name);
      return name;
    } catch {
      return user;
    }
  }

  /** Slack's markup made readable, the people named. */
  async function plain(text: string): Promise<string> {
    const ids = [...new Set([...text.matchAll(MENTION)].map((m) => m[1]!))];
    const known = new Map(await Promise.all(ids.map(async (id) => [id, id === self.userId ? "you" : await nameOf(id)] as const)));
    return unslack(text, (id) => known.get(id) ?? id);
  }

  /** What a message says: its text, its files (and the start of a long paste), its attachments. */
  async function readable(m: SlackMessage): Promise<string> {
    const parts = [m.text ?? ""];
    for (const file of m.files ?? []) parts.push(`[file: ${file.title || file.name || "?"}]${file.preview ? `\n${file.preview}` : ""}`);
    for (const a of m.attachments ?? []) {
      const text = [a.pretext, a.title, a.text].filter(Boolean).join("\n") || a.fallback;
      if (text) parts.push(`[attachment] ${text}`);
    }
    return plain(parts.filter(Boolean).join("\n"));
  }

  async function readThread(address: Address, by = reader): Promise<Thread> {
    let raw: SlackMessage[];
    if (address.thread === "main") {
      const page = await by.conversations.history({ channel: address.conversation, limit: DM_KEEP, inclusive: true, ...(address.ts ? { latest: address.ts } : {}) });
      raw = [...((page.messages ?? []) as SlackMessage[])].reverse();
    } else {
      // Replies come oldest first, by pages: read on to the message, keep the end.
      raw = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < THREAD_PAGES; pages++) {
        const page = await by.conversations.replies({
          channel: address.conversation,
          ts: address.thread,
          limit: 200,
          inclusive: true,
          ...(address.ts ? { latest: address.ts } : {}),
          ...(cursor ? { cursor } : {}),
        });
        raw.push(...((page.messages ?? []) as SlackMessage[]));
        cursor = page.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      // The root stays: it says what the thread is about.
      if (raw.length > THREAD_KEEP) raw = [raw[0]!, ...raw.slice(-(THREAD_KEEP - 1))];
    }
    const messages = await Promise.all(
      raw.map(async (m) => ({
        author: m.user === self.userId || (self.botId && m.bot_id === self.botId) ? "you" : await nameOf(m.user ?? m.bot_id),
        text: await readable(m),
        at: m.ts ? isoOf(m.ts) : "",
      })),
    );
    const name = channelNames.get(address.conversation);
    const label = address.conversation.startsWith("D") ? "in a direct message" : name ? `in #${name}` : "in a channel";
    return { label, messages };
  }

  const connector: Connector = {
    id: "slack",
    reacts: true,

    async start(sink) {
      const auth = await client.auth.test();
      self.userId = auth.user_id ?? "";
      self.botId = auth.bot_id ?? "";
      await loadMembership();
      app.message(async ({ message }) => sink(message));
      app.event("app_mention", async ({ event }) => sink(event));
      app.event("member_joined_channel", async ({ event }) => {
        if (event.user === self.userId) member.set(event.channel, true);
      });
      app.event("channel_left", async ({ event }) => void member.set(event.channel, false));
      receiver.client.on("connected", () => connected.forEach((callback) => callback()));
      receiver.client.on("disconnected", () => disconnected.forEach((callback) => callback()));
      await app.start();
    },

    async stop() {
      await app.stop();
    },

    onConnected(callback) {
      connected.push(callback);
    },

    onDisconnected(callback) {
      disconnected.push(callback);
    },

    /**
     * Slack does not replay what was missed: read every conversation the bot is in since the cursor, with the replies
     * of threads that moved. Roots are read further back (threadLookbackDays): a reply posted while away in an older
     * thread counts too. Only what is newer than the cursor is handed over. A thread older than that is not seen.
     */
    async *catchUp(since) {
      const oldest = (Date.parse(since) / 1000).toFixed(6);
      const roots = ((Date.parse(since) - (options.threadLookbackDays ?? 7) * 86_400_000) / 1000).toFixed(6);
      for (const [channel, isIn] of [...member]) {
        if (!isIn) continue;
        const type = channel.startsWith("D") ? "im" : undefined;
        // Every page. An error stops the pass, which the core tries again from the same cursor; only Slack saying the
        // bot is not in this channel (removed while away, archived) skips it, and it is no longer counted as joined.
        let cursor: string | undefined;
        try {
          do {
            const page = await reader.conversations.history({ channel, oldest: roots, limit: 200, ...(cursor ? { cursor } : {}) });
            for (const message of (page.messages ?? []) as (SlackMessage & { reply_count?: number; latest_reply?: string })[]) {
              if (Number(message.ts ?? 0) > Number(oldest)) yield { ...message, channel, channel_type: type };
              if (message.ts && message.reply_count && Number(message.latest_reply ?? 0) > Number(oldest)) {
                let next: string | undefined;
                do {
                  const replies = await reader.conversations.replies({ channel, ts: message.ts, oldest, limit: 200, ...(next ? { cursor: next } : {}) });
                  for (const reply of (replies.messages ?? []) as SlackMessage[]) {
                    if (reply.ts !== message.ts && Number(reply.ts ?? 0) > Number(oldest)) yield { ...reply, channel, channel_type: type };
                  }
                  next = replies.response_metadata?.next_cursor || undefined;
                } while (next);
              }
            }
            cursor = page.response_metadata?.next_cursor || undefined;
          } while (cursor);
        } catch (error) {
          // Only "not in this channel" skips it; any other error (Slack's own failures included) fails the pass,
          // which the core tries again.
          if (!leftChannel(error)) {
            const read = readError(error);
            throw read instanceof TransientError ? read : new TransientError(error instanceof Error ? error.message : String(error));
          }
          console.error(`slack: catch-up skips ${channel}, the bot is not in it`, error);
          member.set(channel, false);
        }
      }
    },

    async toInbox(raw): Promise<InboxRow | null> {
      const event = raw as SlackMessage;
      if (!event.channel || !event.ts || !SPOKEN.has(event.subtype)) return null;
      if (event.user === self.userId || (self.botId && event.bot_id === self.botId)) return null;
      if (!(await isMember(event.channel))) return null;
      const type = event.channel_type ?? (event.channel.startsWith("D") ? "im" : "channel");
      const dm = type === "im";
      const thread = dm ? (event.thread_ts ?? "main") : (event.thread_ts ?? event.ts);
      const text = event.text ?? "";
      return {
        source_id: `slack:${event.channel}:${event.ts}`,
        address: { connector: "slack", conversation: event.channel, thread, ts: event.ts },
        thread_key: `slack:${event.channel}:${thread}`,
        mode_key: `slack:${event.channel}`,
        author_id: event.user ?? event.bot_id ?? "?",
        author_kind: event.bot_id ? "bot" : "human",
        owner_only: dm && event.user === options.ownerId,
        private: dm || type === "mpim" || type === "group" || (secret.get(event.channel) ?? true),
        dm,
        mentions_agent: Boolean(self.userId) && text.includes(`<@${self.userId}>`),
        mentions_owner: text.includes(`<@${options.ownerId}>`),
        sent_at: isoOf(event.ts),
        payload: event,
        text,
      };
    },

    /** A person (an id, a mention, a name or a first name, if only one person has it) → a direct message with them. */
    async resolve(person: string): Promise<Address | null> {
      try {
        const given = person.trim().replace(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/, "$1").replace(/^@/, "");
        let id = /^[UW][A-Z0-9]{6,}$/.test(given) ? given : undefined;
        if (!id) {
          const wanted = fold(given);
          const all = await directory();
          const exact = all.filter((p) => p.names.includes(wanted));
          const first = all.filter((p) => p.names.some((n) => n.split(/\s+/)[0] === wanted));
          const match = exact.length === 1 ? exact : exact.length === 0 && first.length === 1 ? first : [];
          id = match[0]?.id;
        }
        if (!id) return null;
        const opened = await client.conversations.open({ users: id });
        return opened.channel?.id ? { connector: "slack", conversation: opened.channel.id, thread: "main" } : null;
      } catch (error) {
        throw readError(error);
      }
    },

    async read(address: Address): Promise<Thread> {
      try {
        return await readThread(address);
      } catch (error) {
        // A conversation the bot is not in (found by search): read with the owner's token.
        if (ownerReader && leftChannel(error)) return readThread(address, ownerReader).catch((e: unknown) => Promise.reject(readError(e)));
        throw readError(error);
      }
    },

    ...(ownerReader
      ? {
          async search(query: string, limit: number) {
            type Match = { ts?: string; user?: string; username?: string; text?: string; permalink?: string; channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean } };
            let page;
            try {
              page = await ownerReader.search.messages({ query, count: limit, sort: "timestamp", sort_dir: "desc" });
            } catch (error) {
              throw readError(error);
            }
            const matches = ((page.messages as { matches?: Match[] } | undefined)?.matches ?? []).filter((m) => m.ts && m.channel?.id);
            return Promise.all(
              matches.map(async (m) => {
                const channel = m.channel!;
                const rooted = /[?&]thread_ts=([\d.]+)/.exec(m.permalink ?? "")?.[1];
                const thread = rooted ?? (channel.is_im ? "main" : m.ts!);
                const place = channel.is_im ? "in a direct message" : channel.is_mpim ? "in a group message" : `in #${channel.name ?? channel.id}`;
                return { at: isoOf(m.ts!), author: m.username || (await nameOf(m.user)), place, text: m.text ?? "", address: { connector: "slack", conversation: channel.id!, thread, ts: m.ts! } };
              }),
            );
          },
        }
      : {}),

    form: {
      schema: () =>
        z.object({
          messages: z.array(z.string()).describe("The messages to post, in order. Empty list: say nothing."),
          reaction: z.string().optional().describe("An emoji name (e.g. thumbsup, eyes, white_check_mark) on the last message; often instead of a reply"),
        }),
      prompts: {
        "slack-dm":
          "You are writing on Slack, in a direct message. Be warm and human, like a friendly colleague: short, in the tone used, no headings or lists unless it is technical. You may react to the last message with one emoji (reaction), not every time; a reaction alone (no messages) is enough for a thanks or an ok.",
        "slack-thread":
          "You are writing on Slack, in a thread. Be warm and human, like a friendly colleague: someone who speaks to you, greets you, welcomes you or thanks you always gets something back, a short line or at least a reaction (one emoji on the last message). Short, in the tone used. When the conversation is not about you and you have nothing to add, say nothing (empty list) or just react.",
      },
      guide: (row) => ({ prompt: row.dm ? "slack-dm" : "slack-thread" }),
      toPosts: (output) => {
        const { messages, reaction } = output as { messages: string[]; reaction?: string };
        const posts = messages.filter((text) => text.trim()).map((text): Post => ({ text }));
        return { posts: reaction?.trim() ? [{ reaction: reaction.trim().replace(/^:|:$/g, "") }, ...posts] : posts, held: false };
      },
    },

    async deliver(address, post): Promise<DeliverResult> {
      if ("reaction" in post && !address.ts) return { ok: false, transient: false, error: "no message to react to" };
      const asOwner = "as" in post && post.as === "owner";
      if (asOwner && !options.userToken) return { ok: false, transient: false, error: "no user token to post as the owner" };
      try {
        if ("reaction" in post) {
          await client.reactions.add({ channel: address.conversation, timestamp: address.ts!, name: post.reaction });
          // Dated by the message reacted to: what the agent has seen, for the catch-up.
          return { ok: true, ref: address.ts!, sent_at: isoOf(address.ts!) };
        }
        const sent = await client.chat.postMessage({
          ...(asOwner ? { token: options.userToken } : {}),
          channel: address.conversation,
          text: post.text,
          ...(address.thread !== "main" ? { thread_ts: address.thread } : {}),
        });
        const ts = sent.ts ?? "";
        return { ok: true, ref: ts, sent_at: ts ? isoOf(ts) : new Date().toISOString() };
      } catch (error) {
        const e = error as { code?: string; statusCode?: number; data?: { error?: string }; original?: { code?: string } };
        // Certainly not sent: rate limit, a 5xx answer, a connection refused before sending.
        if (e.code === "slack_webapi_rate_limited_error") return { ok: false, transient: true, error: "ratelimited" };
        if (e.code === "slack_webapi_http_error" && (e.statusCode ?? 0) >= 500) return { ok: false, transient: true, error: `http ${e.statusCode}` };
        if (e.code === "slack_webapi_request_error" && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(e.original?.code ?? "")) {
          return { ok: false, transient: true, error: e.original?.code ?? "request" };
        }
        // Already there: what was asked is done.
        if ("reaction" in post && e.data?.error === "already_reacted") return { ok: true, ref: address.ts!, sent_at: isoOf(address.ts!) };
        // Slack said no: final.
        if (e.code === "slack_webapi_platform_error") return { ok: false, transient: false, error: e.data?.error ?? "platform_error" };
        // Anything else is ambiguous: it may have been posted. The core never sends it again.
        throw error;
      }
    },
  };
  return connector;
}
