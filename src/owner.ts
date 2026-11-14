import type { Command, Core } from "./core.ts";

const cut = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

function waiting(core: Core): string {
  const lots = core.store.held();
  if (!lots.length) return "Nothing waits for you.";
  return lots.map((lot) => `#${lot.batch} (${lot.thread_key}): ${cut(lot.texts.join(" / "))}`).join("\n");
}

/**
 * The owner's commands, in his private conversation with the agent: what waits for him (e-mail replies the agent was
 * not sure of, drafts in his name) leaves only through here. Answered by code, never by the model.
 */
export function ownerCommands(): Command[] {
  const commands: Command[] = [
    {
      pattern: /^(held|waiting)$/i,
      help: "held: what waits for you",
      run: async (_match, core) => waiting(core),
    },
    {
      pattern: /^send\s+#?(\d+)(?:\s*:\s*([\s\S]+))?$/i,
      help: "send <n>, or send <n>: <your text>: let it leave, as is or edited",
      hint: (batch) => `send ${batch} · send ${batch}: <your text>`,
      run: async (match, core) => (core.release(Number(match[1]), match[2]?.trim()) ? `#${match[1]} leaves now.` : `Nothing waits as #${match[1]}.`),
    },
    {
      pattern: /^drop\s+#?(\d+)$/i,
      help: "drop <n>: never send it",
      hint: (batch) => `drop ${batch}`,
      run: async (match, core) => (core.drop(Number(match[1])) ? `#${match[1]} dropped.` : `Nothing waits as #${match[1]}.`),
    },
    {
      pattern: /^(help|\?)$/i,
      help: "help: this list",
      run: async () => commands.map((command) => `- ${command.help}`).join("\n"),
    },
  ];
  return commands;
}
