import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { basename, dirname, join, normalize, relative } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const PAGE = 100;

const escape = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A cell: JSON pretty-printed, long values folded. */
function cell(value: SQLInputValue): string {
  if (value === null) return `<span class="null">null</span>`;
  let text = String(value);
  if (/^[[{]/.test(text)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON: shown as is.
    }
  }
  if (text.length <= 120 && !text.includes("\n")) return escape(text);
  return `<details><summary>${escape(text.slice(0, 80).replace(/\s+/g, " "))}…</summary><pre>${escape(text)}</pre></details>`;
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>
:root{color-scheme:light dark;font:14px/1.4 ui-monospace,Menlo,monospace}
body{margin:16px}a{color:#2563eb}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #8884;padding:4px 6px;text-align:left;vertical-align:top;max-width:480px;overflow-wrap:anywhere}
th{position:sticky;top:0;background:Canvas}.null{opacity:.4}pre{margin:4px 0;white-space:pre-wrap}
form{margin:8px 0}input{font:inherit;padding:4px;width:320px;max-width:100%}nav{margin:8px 0}
textarea{font:inherit;width:100%;min-height:70vh;box-sizing:border-box;padding:8px}.saved{color:#16a34a}
</style></head><body>${body}</body></html>`;

/** A Markdown file inside a folder, symlinks followed, or undefined: nothing outside it is ever read or written. */
function inside(root: string, path: string): string | undefined {
  const clean = normalize(path).replace(/^\/+/, "");
  if (!clean || clean.startsWith("..") || !clean.endsWith(".md") || clean.split("/").some((part) => part.startsWith("."))) return undefined;
  const file = join(root, clean);
  const real = (p: string): string => (existsSync(p) ? realpathSync(p) : dirname(p) === p ? p : join(real(dirname(p)), basename(p)));
  return relative(real(root), real(file)).startsWith("..") ? undefined : file;
}

const markdown = (root: string): string[] =>
  existsSync(root) ? (readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md") && statSync(join(root, f)).isFile()) as string[]).sort() : [];

async function body(request: IncomingMessage): Promise<string> {
  let data = "";
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error("too large");
  }
  return data;
}

/**
 * The web view, for debugging and tuning: the tables (its own read-only connection: it changes no row), newest first,
 * filtered and paged; and folders of Markdown files (the prompts, the memory) to browse, read and edit. Basic auth
 * with one password: the tables hold private conversations, the files change what the agent is told.
 */
export function debugServer(options: { dbPath: string; port: number; password: string; folders?: Record<string, string> }): {
  start(): Promise<Server>;
  stop(): Promise<void>;
} {
  const folders = options.folders ?? {};
  let server: Server | undefined;
  let db: DatabaseSync | undefined;
  const expected = Buffer.from(`debug:${options.password}`);

  const allowed = (header: string | undefined) => {
    const given = Buffer.from(header?.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString() : "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  function render(db: DatabaseSync, url: URL): { status: number; html: string } {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    const match = url.pathname.match(/^\/t\/([a-z_]+)$/);
    if (url.pathname === "/") {
      const rows = tables.map((name) => {
        const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
        return `<tr><td><a href="/t/${name}">${name}</a></td><td>${n}</td></tr>`;
      });
      const files = Object.keys(folders).map((name) => `<tr><td><a href="/f/${name}/">${name}/</a></td><td>${markdown(folders[name]!).length}</td></tr>`);
      const editable = files.length ? `<h2>Files</h2><table><tr><th>folder</th><th>files</th></tr>${files.join("")}</table>` : "";
      return { status: 200, html: page("agent-core", `<h1>agent-core</h1><h2>Tables</h2><table><tr><th>table</th><th>rows</th></tr>${rows.join("")}</table>${editable}`) };
    }
    const file = url.pathname.match(/^\/f\/([a-z0-9-]+)\/(.*)$/);
    if (file && folders[file[1]!]) return files(file[1]!, decodeURIComponent(file[2]!), url);
    if (!match || !tables.includes(match[1]!)) return { status: 404, html: page("not found", `<p>Not found. <a href="/">Tables</a></p>`) };
    const table = match[1]!;
    const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
    const q = url.searchParams.get("q") ?? "";
    const at = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
    // The filter: any column containing the text.
    const where = q ? `WHERE ${columns.map((c) => `CAST("${c}" AS TEXT) LIKE ?`).join(" OR ")}` : "";
    const args: SQLInputValue[] = q ? columns.map(() => `%${q}%`) : [];
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" ${where}`).get(...args) as { n: number };
    const rows = db.prepare(`SELECT * FROM "${table}" ${where} ORDER BY rowid DESC LIMIT ${PAGE} OFFSET ${at * PAGE}`).all(...args) as Record<string, SQLInputValue>[];
    const link = (p: number) => `/t/${table}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;
    const nav = `<nav><a href="/">tables</a> · ${n} rows${at > 0 ? ` · <a href="${link(at - 1)}">← newer</a>` : ""}${(at + 1) * PAGE < n ? ` · <a href="${link(at + 1)}">older →</a>` : ""}</nav>`;
    const head = `<tr>${columns.map((c) => `<th>${escape(c)}</th>`).join("")}</tr>`;
    const body = rows.map((row) => `<tr>${columns.map((c) => `<td>${cell(row[c] ?? null)}</td>`).join("")}</tr>`).join("");
    const form = `<form><input name="q" value="${escape(q)}" placeholder="filter: text in any column" autofocus> <button>filter</button></form>`;
    return { status: 200, html: page(table, `<h1>${table}</h1>${form}${nav}<table>${head}${body}</table>${nav}`) };
  }

  /** A folder's files, or one file in an editor (a missing one is created by saving it). */
  function files(folder: string, path: string, url: URL): { status: number; html: string } {
    const root = folders[folder]!;
    const up = `<nav><a href="/">home</a> · <a href="/f/${folder}/">${folder}/</a></nav>`;
    if (!path) {
      const list = markdown(root).map((f) => `<li><a href="/f/${folder}/${encodeURI(f)}">${escape(f)}</a></li>`);
      const create = `<form onsubmit="location.href='/f/${folder}/'+encodeURI(this.path.value);return false"><input name="path" placeholder="new file, e.g. common/notes.md"> <button>open</button></form>`;
      return { status: 200, html: page(folder, `${up}<h1>${folder}/</h1><ul>${list.join("") || "<li>(empty)</li>"}</ul>${create}`) };
    }
    const target = inside(root, path);
    if (!target) return { status: 404, html: page("not found", `${up}<p>Not a Markdown file of ${folder}/.</p>`) };
    const text = existsSync(target) ? readFileSync(target, "utf8") : "";
    const saved = url.searchParams.has("saved") ? ` <span class="saved">saved</span>` : "";
    const form = `<form method="post"><textarea name="content" spellcheck="false">${escape(text)}</textarea><p><button>save</button>${saved}${existsSync(target) ? "" : " (new file)"}</p></form>`;
    return { status: 200, html: page(`${folder}/${path}`, `${up}<h1>${escape(`${folder}/${path}`)}</h1>${form}`) };
  }

  /** Saves a file: whole or not at all (a tmp file, then renamed), so a prompt is never read half written. */
  async function save(request: IncomingMessage, url: URL): Promise<{ status: number; location?: string; text?: string }> {
    // Another site's form cannot post here with the browser's saved credentials.
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host) return { status: 403, text: "cross-origin" };
    const match = url.pathname.match(/^\/f\/([a-z0-9-]+)\/(.+)$/);
    const root = match ? folders[match[1]!] : undefined;
    const target = match && root ? inside(root, decodeURIComponent(match[2]!)) : undefined;
    if (!target) return { status: 404, text: "not found" };
    const content = new URLSearchParams(await body(request)).get("content") ?? "";
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, content.replace(/\r\n/g, "\n"));
    renameSync(temp, target);
    return { status: 303, location: `${url.pathname}?saved` };
  }

  return {
    async start() {
      const reader = new DatabaseSync(options.dbPath, { readOnly: true });
      db = reader;
      server = createServer((request, response) => {
        if (!allowed(request.headers.authorization)) {
          response.writeHead(401, { "WWW-Authenticate": 'Basic realm="agent-core debug"' }).end();
          return;
        }
        try {
          const url = new URL(request.url ?? "/", "http://debug");
          if (request.method === "POST") {
            void save(request, url)
              .then((saved) => response.writeHead(saved.status, saved.location ? { location: saved.location } : { "content-type": "text/plain" }).end(saved.text ?? ""))
              .catch((error: unknown) => response.writeHead(500, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : String(error)));
            return;
          }
          const { status, html } = render(reader, url);
          response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
        } catch (error) {
          response.writeHead(500, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
        }
      });
      await new Promise<void>((resolve) => server!.listen(options.port, resolve));
      return server;
    },
    async stop() {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      db?.close();
    },
  };
}
