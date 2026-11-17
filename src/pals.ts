import type { Status, StatusFeed } from "./status.ts";

/** He goes idle in the office after this long without a moment. */
const QUIET_MS = 60_000;
/** While the agent runs; without it the office sends him home after 20 minutes. */
const HEARTBEAT_MS = 120_000;

const RECEIVED: Record<string, string> = { slack: "Lit un message Slack", email: "Lit un mail", github: "Regarde GitHub" };

/** A short line for humans, from the state and its detail (a connector, a tool, a repository): never what a message says. */
const label = (s: Status): string => {
  switch (s.state) {
    case "received":
      return RECEIVED[s.detail?.split(":")[0] ?? ""] ?? "Lit un message";
    case "tool":
      return s.detail ? `Utilise ${s.detail}` : "Utilise un outil";
    case "writing":
      return "Écrit";
    case "coding":
      return s.detail ? `Code sur ${s.detail}` : "Code";
    default:
      return "Réfléchit";
  }
};

/**
 * The agent in the Pals Office, a pixel-art office of the team's agents: the status feed turned into signals posted
 * to /api/presence. `prompt` with a status at every moment (at his desk, a bubble), `stop` once quiet (he wanders),
 * a heartbeat while running, `session_end` when it stops. The office does the rest.
 */
export function palsPresence(options: { feed: StatusFeed; token: string; url?: string; fetch?: typeof fetch }) {
  const url = `${options.url ?? "https://pals.ronangaillard.com"}/api/presence`;
  const post = options.fetch ?? fetch;
  let lastError = "";
  // One at a time, in order: a `stop` never overtakes the `prompt` before it.
  let sending = Promise.resolve();
  const signal = (event: "prompt" | "stop" | "heartbeat" | "session_end", status?: string) =>
    (sending = sending.then(async () => {
      try {
        const res = await post(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(status === undefined ? { event } : { event, status: status.slice(0, 120) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        lastError = "";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastError) console.error(`pals: ${event} not sent: ${message}`);
        lastError = message;
      }
    }));

  /** The status on his card: undefined when he is not at his desk, "" once idle (the next moment is a new one). */
  let shown: string | undefined;
  let quiet: NodeJS.Timeout | undefined;
  // A status left from before a restart clears soon.
  void signal("stop");
  const unwatch = options.feed.watch((s) => {
    clearTimeout(quiet);
    if (s.state !== "idle") {
      const status = label(s);
      if (status !== shown) void signal("prompt", (shown = status));
      return;
    }
    if (shown === undefined) return;
    shown = "";
    quiet = setTimeout(() => {
      shown = undefined;
      void signal("stop");
    }, QUIET_MS).unref();
  });
  const beat = setInterval(() => void signal("heartbeat"), HEARTBEAT_MS).unref();

  return {
    stop: () => {
      unwatch();
      clearTimeout(quiet);
      clearInterval(beat);
      return signal("session_end");
    },
  };
}
