import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { z } from "zod";
import type { Scope, ToolDef } from "./types.ts";

const INDEX_MAX = 4000;

/**
 * The agent's memory, in Markdown files: common/ comes up in every conversation, private/ only in the owner's private
 * one. Each folder has an INDEX.md put in the prompt; the rest is read on demand with the tools.
 */
export class Memory {
  constructor(readonly root: string) {
    for (const folder of ["common", "private"]) mkdirSync(join(root, folder), { recursive: true });
  }

  private folders(scope: Scope) {
    return scope.owner ? ["common", "private"] : ["common"];
  }

  /** A path inside an allowed folder, or an error: the scope decides, not the model. */
  private resolve(path: string, scope: Scope): string {
    const clean = normalize(path).replace(/^\/+/, "");
    const folder = clean.split("/")[0] ?? "";
    if (clean.startsWith("..") || !this.folders(scope).includes(folder)) throw new Error(`${path}: not readable here`);
    const absolute = join(this.root, clean);
    if (relative(this.root, absolute).startsWith("..")) throw new Error(`${path}: outside the memory`);
    return absolute;
  }

  /** What goes in the prompt: the indexes this scope may read. */
  index(scope: Scope): string {
    return this.folders(scope)
      .map((folder) => {
        const file = join(this.root, folder, "INDEX.md");
        if (!existsSync(file)) return "";
        const text = readFileSync(file, "utf8");
        return `## ${folder}/INDEX.md\n${text.length > INDEX_MAX ? `${text.slice(0, INDEX_MAX)}\n…` : text}`;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  read(path: string, scope: Scope): string {
    const file = this.resolve(path, scope);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  write(path: string, content: string, scope: Scope) {
    const file = this.resolve(path, scope);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  list(scope: Scope): string[] {
    return this.folders(scope).flatMap((folder) => {
      const dir = join(this.root, folder);
      return existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md")).map((f) => `${folder}/${f}`) : [];
    });
  }

  tools(): ToolDef[] {
    return [
      {
        name: "memory_list",
        description: "List your memory files (Markdown).",
        input: {},
        rules: ["all"],
        run: async (_args, { scope }) => this.list(scope).join("\n") || "(empty)",
      },
      {
        name: "memory_read",
        description: "Read one of your memory files, e.g. common/people/paul.md.",
        input: { path: z.string() },
        rules: ["all"],
        run: async (args, { scope }) => this.read(String(args.path), scope) || "(empty or missing)",
      },
      {
        name: "memory_write",
        description:
          "Write a memory file (whole content). common/ comes up in every conversation; private/ only in the owner's private one. Keep INDEX.md short: it is in every prompt.",
        input: { path: z.string(), content: z.string() },
        rules: ["all"],
        run: async (args, { scope }) => {
          this.write(String(args.path), String(args.content), scope);
          return "written";
        },
      },
    ];
  }
}
