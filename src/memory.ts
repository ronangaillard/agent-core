import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";
import type { Scope, ToolDef } from "./types.ts";

const INDEX_MAX = 4000;
const MEMORY = ["common", "private"];

/**
 * The agent's memory, in Markdown files: common/ comes up in every conversation, private/ only in the owner's private
 * one. Each folder has an INDEX.md put in the prompt; the rest is read on demand with the tools. Who writes it: the
 * owner's conversation only (default: nobody else can plant an instruction that every prompt would then carry), or
 * every conversation (writers "all": the agent learns from anyone, at that risk). The persona is never in it.
 *
 * Shelves: read-only folders anyone may read through the same tools (name → absolute path, e.g. code → the agent's
 * own source). Never written, never put in the prompt.
 */
export class Memory {
  private readonly shelves: Record<string, string>;

  constructor(
    readonly root: string,
    shelves: Record<string, string> = {},
    private readonly writers: "owner" | "all" = "owner",
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

  read(path: string, scope: Scope, seen?: Set<string>): string {
    const { file } = this.resolve(path, scope);
    seen?.add(file);
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : "";
  }

  /** What is in memory comes up in every prompt as trusted: by default, only the owner's conversation writes it. */
  /** A file this scope may write: the owner's conversation (or anyone, writers "all"), never a shelf. */
  private writable(path: string, scope: Scope): string {
    if (this.writers === "owner" && !scope.owner) throw new Error(`${path}: only the owner's conversation writes the memory`);
    const { file, shelf } = this.resolve(path, scope);
    if (shelf) throw new Error(`${path}: a read-only folder`);
    return file;
  }

  /** Whole or not at all: a crash mid-write must not leave a truncated INDEX.md going into every prompt. */
  private save(file: string, content: string) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, content);
    renameSync(temp, file);
  }

  write(path: string, content: string, scope: Scope, seen?: Set<string>) {
    const file = this.writable(path, scope);
    // The whole file is replaced: one not read in this run would lose what the model never saw.
    if (seen && !seen.has(file) && existsSync(file) && readFileSync(file, "utf8").trim()) {
      throw new Error(`${path} already exists and you have not read it: memory_read it first, then write its whole new content, keeping what still holds`);
    }
    seen?.add(file);
    this.save(file, content);
  }

  /**
   * Part of a file changed, the rest untouched: old (found exactly once) → new. Empty old: new added at the end, the
   * file created if missing. The file does not count as read: the model saw only that part.
   */
  edit(path: string, old: string, text: string, scope: Scope): string {
    const file = this.writable(path, scope);
    const exists = existsSync(file);
    const current = exists ? readFileSync(file, "utf8") : "";
    let next: string;
    if (!old) {
      if (!text.trim()) throw new Error("nothing to add: new is empty");
      const glue = current && !current.endsWith("\n") ? "\n" : "";
      next = `${current}${glue}${text}${text.endsWith("\n") ? "" : "\n"}`;
    } else {
      if (!exists) throw new Error(`${path} does not exist: leave old empty to create it`);
      if (old === text) throw new Error("old and new are the same");
      const count = current.split(old).length - 1;
      if (count === 0) throw new Error(`${path}: old not found; memory_read it and copy the exact text`);
      if (count > 1) throw new Error(`${path}: old found ${count} times; include more of the text around it`);
      // split/join: no $-patterns read in the new text.
      next = current.split(old).join(text);
    }
    this.save(file, next);
    const big = basename(file) === "INDEX.md" && next.length > INDEX_MAX ? ` Warning: INDEX.md is ${next.length} characters, only the first ${INDEX_MAX} reach the prompt: shorten it.` : "";
    return `${old ? "changed" : "added"}.${big}`;
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
        run: async (args, { scope, read }) => this.read(String(args.path), scope, read) || "(empty or missing)",
      },
      {
        name: "memory_write",
        description:
          "Create a memory file, or replace one entirely (a restructure; read it first and keep what still holds). To add or change a line, use memory_edit. common/ comes up in every conversation; private/ only in the owner's private one. Keep INDEX.md short: it is in every prompt.",
        input: { path: z.string(), content: z.string() },
        rules: [this.writers],
        effect: true,
        run: async (args, { scope, read }) => {
          this.write(String(args.path), String(args.content), scope, read);
          return "written";
        },
      },
      {
        name: "memory_edit",
        description:
          "Change part of a memory file without rewriting it: the way to add, correct or remove a line. old is the exact text to replace, found once in the file; new replaces it (empty to delete). Leave old empty to add new at the end of the file (created if missing). The rest of the file is untouched.",
        input: { path: z.string(), old: z.string(), new: z.string() },
        rules: [this.writers],
        effect: true,
        run: async (args, { scope }) => this.edit(String(args.path), String(args.old ?? ""), String(args.new ?? ""), scope),
      },
    ];
  }
}
