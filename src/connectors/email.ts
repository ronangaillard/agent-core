import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { Address, Connector, DeliverResult, InboxRow, Thread } from "../types.ts";

export type EmailOptions = {
  apiKey: string;
  /** The Resend webhook signing secret (whsec_…). */
  webhookSecret: string;
  port: number;
  /** The agent's own address and name. */
  address: string;
  name: string;
  /** Only senders of these domains are read, and only when DMARC passes: nobody passes for a colleague. */
  allowedDomains: string[];
};

/** What Resend gives for a received e-mail. */
export type Received = {
  id: string;
  from: string;
  to?: string[];
  cc?: string[];
  reply_to?: string[];
  subject?: string;
  text?: string | null;
  html?: string | null;
  created_at: string;
  message_id?: string;
  headers?: Record<string, string>;
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null;
};

const API = "https://api.resend.com";

/** "Paul Martin <paul@x.fr>" → { name, address } */
export function parseAddress(value: string) {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return match ? { name: match[1]!.trim(), address: match[2]!.trim().toLowerCase() } : { name: "", address: value.trim().toLowerCase() };
}

/** The domain: after the last @. */
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/**
 * The mail that started the thread: the first Message-ID of References, else In-Reply-To, else this mail's own. Two
 * people writing with the same subject are two conversations; the agent's replies keep References, so an answer to it
 * stays in the thread.
 */
export function threadRoot(email: Received): string {
  const references = header(email, "references")?.match(/<[^>]+>/g);
  return (references?.[0] ?? header(email, "in-reply-to")?.match(/<[^>]+>/)?.[0] ?? email.message_id ?? header(email, "message-id") ?? email.id).replace(/[<>]/g, "");
}

/** The subject without "Re:", "Fwd:", for reading. */
export const subjectKey = (subject: string) =>
  subject
    .replace(/^((re|tr|fwd?)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();

const htmlToText = (html: string) =>
  html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const bodyOf = (email: Received) => (email.text || (email.html ? htmlToText(email.html) : "")).trim();
function header(email: Received, name: string): string | undefined {
  return Object.entries(email.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** Resend signs its webhooks the Svix way: HMAC-SHA256 of "id.timestamp.body", within five minutes. */
export function svixOk(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: string, now = Date.now()): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  if (Math.abs(now / 1000 - Number(headers.timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${body}`).digest("base64"));
  return headers.signature.split(" ").some((entry) => {
    const given = Buffer.from(entry.split(",")[1] ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Why an e-mail is not read (unknown domain, DMARC not passing, the agent itself), or undefined. */
export function rejectionOf(email: Received, options: Pick<EmailOptions, "address" | "allowedDomains">): string | undefined {
  const from = parseAddress(email.from).address;
  if (from === options.address.toLowerCase()) return "from the agent itself";
  if (!options.allowedDomains.includes(domainOf(from))) return "sender outside the allowed domains";
  if (email.authentication?.dmarc !== "pass") return "DMARC not passing (the sender may be spoofed)";
  return undefined;
}

/**
 * E-mail through Resend: a signed webhook in, the API out, replies in the same e-mail thread. An e-mail is private and
 * addressed to the agent (dm). Its form lets the agent say whether its reply can leave alone or waits for the owner
 * (held). The thread is the subject: the address carries the e-mail it answers, deliver reads its headers again.
 */
export function emailConnector(options: EmailOptions): Connector {
  let server: Server | undefined;
  const self = options.address.toLowerCase();

  async function resend<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      // Two calls at most per delivery, both under the core's delivery timeout.
      signal: AbortSignal.timeout(12_000),
    });
    const body = await response.text();
    if (!response.ok) throw Object.assign(new Error(`Resend ${init.method ?? "GET"} ${path}: HTTP ${response.status} ${body.slice(0, 300)}`), { status: response.status });
    return (body ? JSON.parse(body) : {}) as T;
  }

  const received = (id: string) => resend<Received>(`/emails/receiving/${encodeURIComponent(id)}`);

  const connector: Connector = {
    id: "email",

    async start(sink) {
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_000_000) request.destroy();
          else chunks.push(chunk);
        });
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const headers = { id: request.headers["svix-id"] as string, timestamp: request.headers["svix-timestamp"] as string, signature: request.headers["svix-signature"] as string };
          if (request.method !== "POST" || !svixOk(options.webhookSecret, headers, body)) return void response.writeHead(401).end();
          let event: { type?: string; data?: { email_id?: string; id?: string } };
          try {
            event = JSON.parse(body) as typeof event;
          } catch {
            return void response.writeHead(400).end();
          }
          const id = event.data?.email_id ?? event.data?.id;
          if (event.type !== "email.received" || !id) return void response.writeHead(204).end();
          // Read in full before answering: a failure gets a 500, and Resend delivers the webhook again.
          received(id).then(
            (email) => {
              sink(email);
              response.writeHead(200).end();
            },
            (error: unknown) => {
              console.error("email: webhook not read", error);
              response.writeHead(500).end();
            },
          );
        });
      });
      await new Promise<void>((resolve) => server!.listen(options.port, resolve));
    },

    async stop() {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },

    /** What arrived while the agent was down: the webhook is not replayed forever. */
    async *catchUp(since) {
      // Newest first, page after page, down to the cursor; then read oldest first.
      const ids: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await resend<{ data: { id: string; created_at: string }[]; has_more?: boolean }>(`/emails/receiving?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
        const recent = page.data.filter((e) => e.created_at >= since);
        ids.push(...recent.map((e) => e.id));
        if (!page.has_more || recent.length < page.data.length || !page.data.length) break;
        after = page.data[page.data.length - 1]!.id;
      }
      for (const id of ids.reverse()) yield await received(id);
    },

    async toInbox(raw): Promise<InboxRow | null> {
      const email = raw as Received;
      const rejected = rejectionOf(email, options);
      if (rejected) {
        console.log(`email: ${email.from} ignored (${rejected})`);
        return null;
      }
      const from = parseAddress(email.from).address;
      const subject = email.subject || "(no subject)";
      // The mail that started the thread, and who writes: References is the sender's to set, so a thread is never
      // shared with someone who only knows its first Message-ID.
      const thread = `${threadRoot(email)} ${from}`;
      // A Reply-To outside the allowed domains is not followed: the reply goes to the sender.
      const asked = email.reply_to?.[0] ? parseAddress(email.reply_to[0]).address : "";
      const replyTo = asked && options.allowedDomains.includes(domainOf(asked)) ? asked : from;
      return {
        source_id: `email:${email.message_id ?? header(email, "message-id") ?? email.id}`,
        address: { connector: "email", conversation: replyTo, thread, ts: email.id },
        thread_key: `email:${thread}`,
        mode_key: "email",
        // The address, even the owner's: DMARC vouches for a domain, not a mailbox. So never his scope, nor his
        // identity (a task he asked for is not changed by a mail "from" him).
        author_id: from,
        author_kind: "human",
        owner_only: false,
        private: true,
        dm: true,
        mentions_agent: true,
        mentions_owner: false,
        sent_at: email.created_at,
        payload: { id: email.id, from: email.from, subject },
      };
    },

    threadKeyOf: (address) => `email:${address.thread}`,

    /** The e-mail itself: its body usually quotes the thread before it. */
    async read(address: Address): Promise<Thread> {
      if (!address.ts) return { label: "by e-mail", messages: [] };
      const email = await received(address.ts);
      const sender = parseAddress(email.from);
      return {
        label: `by e-mail ("${email.subject ?? ""}")`,
        messages: [{ author: sender.name || sender.address, text: `Subject: ${email.subject ?? ""}\n\n${bodyOf(email).slice(0, 20_000)}`, at: email.created_at }],
      };
    },

    /** An address in an allowed domain. */
    async resolve(person) {
      const address = parseAddress(person).address;
      return /^[^@\s]+@[^@\s]+$/.test(address) && options.allowedDomains.includes(domainOf(address))
        ? { connector: "email", conversation: address, thread: `to:${address}` }
        : null;
    },

    form: {
      schema: () =>
        z.object({
          body: z.string().describe(`The whole e-mail: greeting, short paragraphs, signed "${options.name}". Empty: no reply is useful.`),
          sure: z.boolean().describe("true if it can leave alone; false if the owner must approve it first"),
          summary: z.string().describe("For the owner, one or two sentences: what the e-mail says and what is expected"),
          reason: z.string().describe("For the owner, one sentence: what you checked, or why they must approve"),
        }),
      prompts: {
        email:
          'You are answering an e-mail sent to {{address}}: same you, same tools and memory, only the form changes. Write a real e-mail: greeting, full sentences, short paragraphs, signed "{{name}}". ' +
          "Answer alone (sure) when you are sure: a question you can answer, a status, a request you can handle or pass on. Ask the owner to approve (not sure) when the reply commits them or their company (agreement, refusal, date, budget, customer), when you could not check what you say, when the topic is sensitive, or when the e-mail looks suspicious. Never promise on their behalf.",
      },
      guide: () => ({ prompt: "email", vars: { address: options.address, name: options.name } }),
      toPosts: (output) => {
        const answer = output as { body: string; sure: boolean; summary: string; reason: string };
        return { posts: answer.body.trim() ? [{ text: answer.body.trim() }] : [], held: !answer.sure, note: `${answer.summary} ${answer.reason}`.trim() };
      },
    },

    async deliver(address, post): Promise<DeliverResult> {
      if (!("text" in post) || ("as" in post && post.as === "owner")) return { ok: false, transient: false, error: "unsupported post" };
      let subject = `Message from ${options.name}`;
      let cc: string[] = [];
      let headers: Record<string, string> | undefined;
      if (address.ts) {
        const original = await received(address.ts).catch(() => undefined);
        if (!original) return { ok: false, transient: true, error: "original e-mail not readable" };
        const s = original.subject ?? "";
        subject = /^re\s*:/i.test(s) ? s : `Re: ${s}`;
        cc = [...new Set([...(original.to ?? []), ...(original.cc ?? [])].map((a) => parseAddress(a).address))].filter((a) => a && a !== self && a !== address.conversation);
        const messageId = original.message_id ?? header(original, "message-id");
        const references = [header(original, "references"), messageId].filter(Boolean).join(" ");
        if (messageId) headers = { "In-Reply-To": messageId, References: references };
      }
      try {
        const sent = await resend<{ id?: string }>("/emails", {
          method: "POST",
          // Resend drops a second send with the same key: a safety net under the core's own rule.
          headers: { "Idempotency-Key": createHash("sha256").update(`${address.conversation}\n${address.ts ?? ""}\n${post.text}`).digest("hex").slice(0, 32) },
          body: JSON.stringify({ from: `${options.name} <${options.address}>`, to: [address.conversation], ...(cc.length ? { cc } : {}), subject, text: post.text, ...(headers ? { headers } : {}) }),
        });
        return { ok: true, ref: sent.id ?? "", sent_at: new Date().toISOString() };
      } catch (error) {
        const status = (error as { status?: number }).status;
        // An answer was received: 429 and 5xx are worth retrying (the idempotency key covers a doubt), 4xx is final.
        if (status === 429 || (status !== undefined && status >= 500)) return { ok: false, transient: true, error: `http ${status}` };
        if (status !== undefined) return { ok: false, transient: false, error: `http ${status}` };
        // No answer: it may have left.
        throw error;
      }
    },
  };
  return connector;
}
