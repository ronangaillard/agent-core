import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import type { RemoteTerminal, Terminal } from "./claude-code.ts";

export type ApercuOptions = {
  /** e.g. http://10.88.0.1:3150 */
  url: string;
  token: string;
};

class ApercuError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * One call to the service. node:http, not fetch: a command can run up to 30 minutes and the service answers only at
 * the end, while fetch gives up on headers that take more than 5 minutes. Only our own deadline applies.
 */
function call<T>(options: ApercuOptions, method: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const url = new URL(path, options.url.endsWith("/") ? options.url : `${options.url}/`);
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((done, fail) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (data += chunk));
        response.on("end", () => {
          let parsed: T & { erreur?: string };
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { erreur: data.slice(0, 300) } as T & { erreur?: string };
          }
          const status = response.statusCode ?? 500;
          if (status >= 400) fail(new ApercuError(`steve-apercu ${method} ${url.pathname}: ${status} ${parsed.erreur ?? ""}`.trim(), status));
          else done(parsed);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`steve-apercu ${method} ${url.pathname}: no answer`)));
    req.on("error", fail);
    req.end(payload);
  });
}

type Workshop = { id: string; copie: string; dossier: string };

/**
 * The terminal of a code task in steve-apercu's workshop ("atelier"): a rootless container per copy, with only that
 * copy mounted at the same path as here, no token, and a network limited to package registries. The copy must be a
 * direct child of the workspace that the service sees.
 */
export function apercuTerminal(options: ApercuOptions): RemoteTerminal {
  return async (dir: string): Promise<Terminal> => {
    const open = async () => {
      // The first time, the service builds the workshop's image.
      const workshop = await call<Workshop>(options, "POST", "ateliers", { copie: basename(dir) }, 15 * 60_000);
      if (workshop.dossier !== dir) {
        await call(options, "DELETE", `ateliers/${encodeURIComponent(workshop.id)}`, undefined, 60_000).catch(() => undefined);
        throw new Error(`the workshop mounts the copy at ${workshop.dossier}, not ${dir}: the paths must match`);
      }
      return workshop;
    };
    let workshop = await open();
    const exec = (command: string, timeoutSeconds: number) =>
      call<{ code: number; sortie: string }>(options, "POST", `ateliers/${encodeURIComponent(workshop.id)}/exec`, { commande: command, delai: timeoutSeconds }, (timeoutSeconds + 120) * 1000);
    return {
      async run(command, timeoutSeconds) {
        let result;
        try {
          result = await exec(command, timeoutSeconds);
        } catch (error) {
          // Closed meanwhile (hours without a command, or the service restarted): open it again, once.
          if (!(error instanceof ApercuError && error.status === 404)) throw error;
          workshop = await open();
          result = await exec(command, timeoutSeconds);
        }
        return { code: result.code, output: result.sortie };
      },
      async close() {
        await call(options, "DELETE", `ateliers/${encodeURIComponent(workshop.id)}`, undefined, 60_000);
      },
    };
  };
}
