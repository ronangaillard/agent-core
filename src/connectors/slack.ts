import bolt from "@slack/bolt";
import { z } from "zod";
import { TransientError, type Address, type Connector, type DeliverResult, type InboxRow, type Post, type Thread } from "../types.ts";

const { App, SocketModeReceiver, webApi } = bolt;

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
};

/** Message subtypes that are real messages; edits, joins, deletions… are not. */
const SPOKEN = new Set([undefined, "file_share", "bot_message", "thread_broadcast"]);

const isoOf = (ts: string) => new Date(Number(ts) * 1000).toISOString();

/**
 * Slack through Socket Mode. The membership cache is filled at start with the bot token; a miss costs one call.
 * A conversation the bot is not in never becomes a row (the owner's DMs with others included).
 */
export function slackConnector(options: { botToken: string; appToken: string; ownerId: string; /** To post the owner's approved drafts in his name. */ userToken?: string }): Connector {
  const receiver = new SocketModeReceiver({ appToken: options.appToken });
  // No silent retries in the client: a retried post is a possible double. The core decides.
  const app = new App({ token: options.botToken, receiver, clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true } });
  const client = app.client;
  // Reads may wait out a rate limit and retry (a read twice harms nothing); posts never do.
  const reader = new webApi.WebClient(options.botToken, { retryConfig: { retries: 5, factor: 2, minTimeout: 1000, maxTimeout: 30_000 } });
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
    } catch {
      return false;
    }
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

  async function readThread(address: Address): Promise<Thread> {
    const page =
      address.thread === "main"
        ? await reader.conversations.history({ channel: address.conversation, limit: 30, inclusive: true, ...(address.ts ? { latest: address.ts } : {}) })
        : await reader.conversations.replies({ channel: address.conversation, ts: address.thread, limit: 100, inclusive: true, ...(address.ts ? { latest: address.ts } : {}) });
    const raw = (page.messages ?? []) as SlackMessage[];
    const ordered = address.thread === "main" ? [...raw].reverse() : raw;
    const messages = await Promise.all(
      ordered.map(async (m) => ({
        author: m.user === self.userId || (self.botId && m.bot_id === self.botId) ? "you" : await nameOf(m.user ?? m.bot_id),
        text: m.text ?? "",
        at: m.ts ? isoOf(m.ts) : "",
      })),
    );
    const name = channelNames.get(address.conversation);
    const label = address.conversation.startsWith("D") ? "in a direct message" : name ? `in #${name}` : "in a channel";
    return { label, messages };
  }

  const connector: Connector = {
    id: "slack",

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
     * of threads that moved. A thread whose root is older than the cursor is not seen (a known limit).
     */
    async *catchUp(since) {
      const oldest = (Date.parse(since) / 1000).toFixed(6);
      for (const [channel, isIn] of member) {
        if (!isIn) continue;
        const type = channel.startsWith("D") ? "im" : undefined;
        // Every page; an error stops the pass, which the core tries again from the same cursor.
        let cursor: string | undefined;
        do {
          const page = await reader.conversations.history({ channel, oldest, limit: 200, ...(cursor ? { cursor } : {}) });
          for (const message of (page.messages ?? []) as (SlackMessage & { reply_count?: number; latest_reply?: string })[]) {
            yield { ...message, channel, channel_type: type };
            if (message.ts && message.reply_count && Number(message.latest_reply ?? 0) > Number(oldest)) {
              let next: string | undefined;
              do {
                const replies = await reader.conversations.replies({ channel, ts: message.ts, oldest, limit: 200, ...(next ? { cursor: next } : {}) });
                for (const reply of (replies.messages ?? []) as SlackMessage[]) if (reply.ts !== message.ts) yield { ...reply, channel, channel_type: type };
                next = replies.response_metadata?.next_cursor || undefined;
              } while (next);
            }
          }
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor);
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

    async read(address: Address): Promise<Thread> {
      try {
        return await readThread(address);
      } catch (error) {
        throw readError(error);
      }
    },

    form: {
      schema: () =>
        z.object({
          messages: z.array(z.string()).describe("The messages to post, in order. Empty list: say nothing."),
        }),
      guide: (row) =>
        row.dm
          ? "You are writing on Slack, in a direct message. Answer like a person on Slack: short, in the tone used, no headings or lists unless it is technical."
          : "You are writing on Slack, in a thread. Short, in the tone used. If you have nothing useful to add, say nothing (empty list).",
      toPosts: (output) => ({
        posts: (output as { messages: string[] }).messages.filter((text) => text.trim()).map((text): Post => ({ text })),
        held: false,
      }),
    },

    async deliver(address, post): Promise<DeliverResult> {
      if (!("text" in post)) return { ok: false, transient: false, error: "unsupported post" };
      const asOwner = "as" in post && post.as === "owner";
      if (asOwner && !options.userToken) return { ok: false, transient: false, error: "no user token to post as the owner" };
      try {
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
        // Slack said no: final.
        if (e.code === "slack_webapi_platform_error") return { ok: false, transient: false, error: e.data?.error ?? "platform_error" };
        // Anything else is ambiguous: it may have been posted. The core never sends it again.
        throw error;
      }
    },
  };
  return connector;
}
