import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import { createInterface } from "node:readline";

export type ApercuOptions = {
  /** e.g. http://10.88.0.1:3150 */
  url: string;
  token: string;
};

export class ApercuError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A task's container: only its copy, mounted at the same path as here, and the session's own tokens. */
export type Workshop = {
  /**
   * A long command (the task's Claude Code session), its output line by line while it runs, then its exit code.
   * env reaches the command only (the service passes it through podman's environment, not its arguments).
   */
  session(command: string, env: Record<string, string>, signal: AbortSignal): AsyncGenerator<string, number>;
  close(): Promise<void>;
};
/** Opens the workshop of a copy (an absolute path, which must be the same path inside the container). */
export type OpenWorkshop = (dir: string) => Promise<Workshop>;

function send(options: ApercuOptions, method: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<IncomingMessage> {
  const url = new URL(path, options.url.endsWith("/") ? options.url : `${options.url}/`);
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((done, fail) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: timeoutMs,
        ...(signal ? { signal } : {}),
      },
      async (response) => {
        const status = response.statusCode ?? 500;
        if (status < 400) return done(response);
        let data = "";
        response.setEncoding("utf8");
        for await (const chunk of response) data += chunk;
        let error = data.slice(0, 300);
        try {
          error = (JSON.parse(data) as { erreur?: string }).erreur ?? error;
        } catch {
          // Not JSON: the text itself.
        }
        fail(new ApercuError(`steve-apercu ${method} ${url.pathname}: ${status} ${error}`.trim(), status));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`steve-apercu ${method} ${url.pathname}: no answer`)));
    req.on("error", fail);
    req.end(payload);
  });
}

/** One call answered in JSON. node:http, not fetch: only our own deadline applies. */
async function call<T>(options: ApercuOptions, method: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const response = await send(options, method, path, body, timeoutMs);
  let data = "";
  response.setEncoding("utf8");
  for await (const chunk of response) data += chunk;
  return JSON.parse(data || "{}") as T;
}

type Opened = { id: string; copie: string; dossier: string };

/**
 * Code tasks in steve-apercu's workshop ("atelier"): a rootless container per copy, with only that copy mounted at the
 * same path as here, and a network limited to package registries, GitHub and Anthropic's API.
 */
export function apercuWorkshop(options: ApercuOptions): OpenWorkshop {
  return async (dir: string): Promise<Workshop> => {
    const open = async () => {
      // The first time, the service builds the workshop's image.
      let workshop = await call<Opened>(options, "POST", "ateliers", { copie: basename(dir) }, 30 * 60_000);
      // A fresh container each run: one left from a run cut short (this process killed) may still hold its session.
      await call(options, "DELETE", `ateliers/${encodeURIComponent(workshop.id)}`, undefined, 60_000);
      workshop = await call<Opened>(options, "POST", "ateliers", { copie: basename(dir) }, 30 * 60_000);
      if (workshop.dossier !== dir) {
        await call(options, "DELETE", `ateliers/${encodeURIComponent(workshop.id)}`, undefined, 60_000).catch(() => undefined);
        throw new Error(`the workshop mounts the copy at ${workshop.dossier}, not ${dir}: the paths must match`);
      }
      return workshop;
    };
    const workshop = await open();
    const path = `ateliers/${encodeURIComponent(workshop.id)}`;
    return {
      async *session(command, env, signal) {
        // No deadline of the socket's: a session runs for long and stays quiet while a tool works; the caller's
        // signal (its own deadline, an abandon) ends it, and closing the workshop stops the command.
        const response = await send(options, "POST", `${path}/session`, { commande: command, env }, 0, signal);
        response.setEncoding("utf8");
        let code: number | undefined;
        for await (const line of createInterface({ input: response, crlfDelay: Infinity })) {
          const exit = /^__exit__ (-?\d+)$/.exec(line);
          if (exit) code = Number(exit[1]);
          else yield line;
        }
        if (code === undefined) throw new Error("the workshop session was cut before its end");
        return code;
      },
      async close() {
        await call(options, "DELETE", path, undefined, 60_000);
      },
    };
  };
}
