import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
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
</style></head><body>${body}</body></html>`;

/**
 * A read-only view of the database, for debugging: the tables, then each one newest first, filtered and paged. Its
 * own read-only connection: it can change nothing. Basic auth with one password: the tables hold private
 * conversations.
 */
export function debugServer(options: { dbPath: string; port: number; password: string }): { start(): Promise<Server>; stop(): Promise<void> } {
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
      return { status: 200, html: page("agent-core", `<h1>agent-core</h1><table><tr><th>table</th><th>rows</th></tr>${rows.join("")}</table>`) };
    }
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
          const { status, html } = render(reader, new URL(request.url ?? "/", "http://debug"));
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
