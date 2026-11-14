import { z } from "zod";
import type { Core } from "./core.ts";
import type { ToolDef } from "./types.ts";

const YEAR_MS = 365 * 24 * 3600_000;

/** The agent acting beyond its reply: posting elsewhere, and reminders on the current conversation. */
export function actTools(core: Core): ToolDef[] {
  const known = core.destinationNames();
  return [
    {
      name: "send",
      description:
        "Post a message somewhere else than this conversation (your reply already goes here). " +
        (known.length ? `Destinations: ${known.join(", ")}. ` : "") +
        "The owner may also name a person (direct message) or message:<id> (the thread of that message). One call per message; never call again after 'Status unknown'.",
      input: { to: z.string().describe("A destination, a person, or message:<id>"), text: z.string().min(1) },
      rules: ["all"],
      effect: true,
      run: (args, context) => core.send(context, String(args.to), String(args.text)),
    },
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
