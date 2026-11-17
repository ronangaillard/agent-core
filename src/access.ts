import type { BoundTool, Rule, Scope, ToolContext, ToolDef } from "./types.ts";

export function allows(rules: readonly Rule[], scope: Scope): boolean {
  return rules.includes("all") || (rules.includes("owner") && scope.owner);
}

/**
 * The tools of one respond(): only those the scope allows (the model never sees the others), each checking its rule
 * again when it runs (second lock).
 */
export function bind(tools: readonly ToolDef[], context: ToolContext): BoundTool[] {
  return tools
    .filter((tool) => allows(tool.rules, context.scope))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input: tool.input,
      ...(tool.effect ? { effect: true } : {}),
      ...(tool.recorded ? { recorded: true } : {}),
      run: async (args) => {
        if (!allows(tool.rules, context.scope)) throw new Error(`${tool.name}: not allowed here`);
        return tool.run(args, context);
      },
    }));
}
