import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";
import type { Scope, ToolDef } from "./types.ts";

const INDEX_MAX = 4000;
const MEMORY = ["common", "private"];

/**
 * The agent's memory, in Markdown files: common/ comes up in every conversation, private/ only in the owner's private
 * one. Each folder has an INDEX.md put in the prompt; the rest is read on demand with the tools. Only the owner's
 * conversation writes it: nobody else can plant an instruction that every prompt would then carry.
 *
 * Shelves: read-only folders anyone may read through the same tools (name → absolute path, e.g. code → the agent's
 * own source). Never written, never put in the prompt.
 */
export class Memory {
  private readonly shelves: Record<string, string>;

  constructor(
    readonly root: string,
    shelves: Record<string, string> = {},
  ) {
    for (const folder of MEMORY) mkdirSync(join(root, folder), { recursive: true });
    for (const name of Object.keys(shelves)) if (MEMORY.includes(name) || !/^[a-z0-9-]+$/.test(name)) throw new Error(`shelf ${name}: not a valid name`);
    this.shelves = Object.fromEntries(Object.entries(shelves).map(([name, path]) => [name, resolve(path)]));
  }

  private folders(scope: Scope) {
    return [...(scope.owner ? MEMORY : ["common"]), ...Object.keys(this.shelves)];
  }

  /** The folder a name stands for: the memory's, or a shelf. */
  private base(folder: string): string {
    return this.shelves[folder] ?? join(this.root, folder);
  }

  /** A path inside an allowed folder, symlinks followed, or an error: the scope decides, not the model. */
  private resolve(path: string, scope: Scope): { file: string; shelf: boolean } {
    const clean = normalize(path).replace(/^\/+/, "");
    const [folder = "", ...rest] = clean.split("/");
    if (clean.startsWith("..") || !this.folders(scope).includes(folder)) throw new Error(`${path}: not readable here`);
    const base = this.base(folder);
    const file = join(base, ...rest);
    // Symlinks followed; a file not written yet is judged by its nearest existing folder.
    const real = (p: string): string => (existsSync(p) ? realpathSync(p) : dirname(p) === p ? p : join(real(dirname(p)), basename(p)));
    if (relative(real(base), real(file)).startsWith("..")) throw new Error(`${path}: outside the memory`);
    return { file, shelf: folder in this.shelves };
  }

  /** What goes in the prompt: the indexes of the memory this scope may read (never a shelf). */
  index(scope: Scope): string {
    return (scope.owner ? MEMORY : ["common"])
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
    const { file } = this.resolve(path, scope);
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : "";
  }

  /** Only the owner writes: what is in memory comes up in every prompt, his private one included, as trusted. */
  write(path: string, content: string, scope: Scope) {
    if (!scope.owner) throw new Error(`${path}: only the owner's conversation writes the memory`);
    const { file, shelf } = this.resolve(path, scope);
    if (shelf) throw new Error(`${path}: a read-only folder`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  /** The memory's Markdown files, and every file of the shelves. */
  list(scope: Scope): string[] {
    return this.folders(scope).flatMap((folder) => {
      const dir = this.base(folder);
      if (!existsSync(dir)) return [];
      const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile());
      return files.filter((f) => folder in this.shelves || f.endsWith(".md")).map((f) => `${folder}/${f}`);
    });
  }

  tools(): ToolDef[] {
    const shelves = Object.keys(this.shelves);
    const also = shelves.length ? ` Also read-only folders: ${shelves.map((s) => `${s}/`).join(", ")}${shelves.includes("code") ? " (code/: your own source, the version running)" : ""}.` : "";
    return [
      {
        name: "memory_list",
        description: `List your memory files (Markdown).${also}`,
        input: {},
        rules: ["all"],
        run: async (_args, { scope }) => this.list(scope).join("\n") || "(empty)",
      },
      {
        name: "memory_read",
        description: `Read one of your memory files, e.g. common/people/paul.md.${also}`,
        input: { path: z.string() },
        rules: ["all"],
        run: async (args, { scope }) => this.read(String(args.path), scope) || "(empty or missing)",
      },
      {
        name: "memory_write",
        description:
          "Write a memory file (whole content). common/ comes up in every conversation; private/ only in the owner's private one. Keep INDEX.md short: it is in every prompt.",
        input: { path: z.string(), content: z.string() },
        rules: ["owner"],
        effect: true,
        run: async (args, { scope }) => {
          this.write(String(args.path), String(args.content), scope);
          return "written";
        },
      },
    ];
  }
}
