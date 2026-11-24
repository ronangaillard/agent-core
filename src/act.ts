import { z } from "zod";
import type { Core } from "./core.ts";
import type { ToolContext, ToolDef } from "./types.ts";

const YEAR_MS = 365 * 24 * 3600_000;

/** The agent acting beyond its reply: posting elsewhere, and reminders on the current conversation. */
export function actTools(core: Core): ToolDef[] {
  return [
    {
      name: "send",
      description:
        "Post a message somewhere else than this conversation (your reply already goes here): any channel (#name), " +
        "a person by name (direct message), or message:<id> (the thread of that message). One call per message; never call again after 'Status unknown'.",
      input: { to: z.string().describe("#channel, a person, or message:<id>"), text: z.string().min(1) },
      rules: ["all"],
      effect: true,
      recorded: true,
      run: (args, context) => core.send(context, String(args.to), String(args.text)),
    },
    {
      name: "read_conversation",
      description:
        "Read in full another conversation, given one of its messages: message:<id> (from <elsewhere> or search_conversations) or found:<n> (from search_messages).",
      input: { message: z.string().describe("message:<id> or found:<n>") },
      rules: ["all"],
      run: (args, context) => core.readConversation(context, String(args.message)),
    },
    ...(core.opensFiles()
      ? [
          {
            name: "open_file",
            description: "Open a file shared in a conversation, given its file:<id> from the message: look at an image (a screenshot, a photo), read a text file.",
            input: { file: z.string().describe("file:<id>") },
            rules: ["all" as const],
            run: (args: Record<string, unknown>, context: ToolContext) => core.openFile(context, String(args.file)),
          },
        ]
      : []),
    ...(core.searchable()
      ? [
          {
            name: "search_messages",
            description:
              "Search all the messages of the workspace (Slack…), not only your conversations, with the owner's rights: when something talked about likely comes from a conversation you were not in, or predates what search_conversations remembers. Then read_conversation with a found:<n>.",
            input: { query: z.string().min(1).describe("Words, as in the app's search box"), limit: z.number().int().min(1).max(20).optional() },
            // With the owner's rights: the owner's tool, unless privacy is off.
            rules: [core.privacy.on ? ("owner" as const) : ("all" as const)],
            run: (args: Record<string, unknown>, context: ToolContext) => core.searchMessages(context, String(args.query), Number(args.limit ?? 10)),
          },
        ]
      : []),
    ...(core.editsPosts()
      ? [
          {
            name: "edit_message",
            description: "Rewrite one of your own messages, given its post:<n> (shown next to \"you\", here or in a conversation read with read_conversation). The whole new text. Elsewhere than here: only for the owner.",
            input: { message: z.string().describe("post:<n>"), text: z.string().min(1) },
            rules: ["all" as const],
            effect: true,
            run: (args: Record<string, unknown>, context: ToolContext) => core.editPost(context, String(args.message), String(args.text)),
          },
          {
            name: "delete_message",
            description: "Delete one of your own messages, given its post:<n> (shown next to \"you\", here or in a conversation read with read_conversation). Elsewhere than here: only for the owner.",
            input: { message: z.string().describe("post:<n>") },
            rules: ["all" as const],
            effect: true,
            run: (args: Record<string, unknown>, context: ToolContext) => core.deletePost(context, String(args.message)),
          },
        ]
      : []),
    {
      name: "set_reminder",
      description: "Be woken up later in this conversation, with this note. The note is all you will have: make it self-contained.",
      input: {
        at: z.string().describe("ISO 8601 date-time with its offset, e.g. 2026-03-02T09:00:00+01:00"),
        every_minutes: z.number().int().min(5).optional().describe("Repeat at this interval"),
        note: z.string().min(1),
      },
      rules: ["all"],
      effect: true,
      recorded: true,
      run: async (args, context) => {
        const at = Date.parse(String(args.at));
        if (Number.isNaN(at)) return "Invalid date: give an ISO 8601 date-time with its offset.";
        if (at < Date.now() - 60_000 || at > Date.now() + YEAR_MS) return "The date must be in the future, within a year.";
        const every = args.every_minutes === undefined ? null : Number(args.every_minutes);
        return core.remind(context, new Date(at).toISOString(), every, String(args.note));
      },
    },
    {
      name: "list_reminders",
      description: "The reminders set in this conversation.",
      input: {},
      rules: ["all"],
      run: async (_args, { threadKey }) => {
        const list = core.store.reminders(threadKey);
        return list.map((r) => `#${r.id} ${r.due_at}${r.repeat_minutes ? ` (every ${r.repeat_minutes} min)` : ""}: ${r.note}`).join("\n") || "No reminder here.";
      },
    },
    {
      name: "cancel_reminder",
      description: "Cancel a reminder of this conversation.",
      input: { id: z.number().int() },
      rules: ["all"],
      effect: true,
      run: async (args, { threadKey }) => (core.store.cancelReminder(Number(args.id), threadKey) ? "Cancelled." : "No such reminder here."),
    },
  ];
}
