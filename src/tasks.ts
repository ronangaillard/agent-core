import { z } from "zod";
import type { Core } from "./core.ts";
import type { Store, TaskRecord } from "./store.ts";
import { localTime, mayRecall, type Privacy, type Scope, type ToolDef } from "./types.ts";

/** One run of a code task, as the core hands it to the runner. */
export type TaskRun = {
  /** task.owner_asked: the owner asked (and every continuation too). A runner gives an owner-only capability (prod
   * data, approving a PR) only then; the Claude Code runner has none. */
  task: TaskRecord;
  request: string;
  /** The conversation it was asked in, readable. */
  conversation: string;
  /** Run again after a restart cut it: the copy may hold work in progress. */
  resumed: boolean;
  signal: AbortSignal;
  /** A short note to the conversation (at most 5, spaced out: the core drops the others). */
  progress(text: string): void;
  /** The PR opened for the task: one per task, kept for the next runs. */
  setPr(pr: number): void;
};

/** The task's final word: posted in its conversation. waiting: a PR is open; done: nothing left to do. */
export type TaskOutcome = { report: string; status: "waiting" | "done" };

/** Does the work: a copy, a branch, a session with a terminal. Throws when it cannot. */
export type TaskRunner = (run: TaskRun) => Promise<TaskOutcome>;

/** The same rule as the digest. */
export const taskVisible = (task: TaskRecord, scope: Scope, privacy: Privacy) => mayRecall({ private: task.private, author: task.requester }, scope, privacy);

const ago = (at: string) => {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  return minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
};

export const taskLine = (task: TaskRecord) =>
  `task #${task.id} "${task.title}" · ${task.repo}${task.pr ? ` · PR #${task.pr}` : ""} · ${task.status}${task.status === "done" ? ` ${ago(task.updated_at)}` : ""} · ${task.thread_key}`;

/**
 * What the agent has going on, for the prompt: code tasks (open, or done within 7 days), upcoming reminders, and for
 * the owner what waits for his approval. Filtered like <elsewhere>: nothing private of someone else.
 */
export function inProgress(store: Store, scope: Scope, privacy: Privacy, threadKey: string): string {
  const lines: string[] = [];
  for (const task of store.recentTasks(new Date(Date.now() - 7 * 24 * 3600_000).toISOString())) if (task.thread_key === threadKey || taskVisible(task, scope, privacy)) lines.push(`- ${taskLine(task)}`);
  for (const reminder of store.upcomingReminders(10)) {
    if (reminder.thread_key !== threadKey && !mayRecall({ private: reminder.private, author: reminder.created_by ?? "" }, scope, privacy)) continue;
    lines.push(`- reminder #${reminder.id} at ${localTime(reminder.due_at)}: "${reminder.note}" · ${reminder.thread_key}`);
  }
  if (scope.owner) for (const lot of store.held()) lines.push(`- waiting for the owner's approval #${lot.batch}: "${lot.texts.join(" / ").slice(0, 120)}" · ${lot.thread_key}`);
  return lines.join("\n");
}

export const TASK_GUIDE =
  "Code tasks: to change or complete a code task, find it in <in_progress> and pass its number as task. In the conversation where it was asked, it is automatic. If two tasks may match, ask which one. A new, unrelated piece of work: new: true.";

/** The tool that starts or continues a code task. The code decides which task and with which rights. */
export function taskTools(core: Core, repos: string[]): ToolDef[] {
  return [
    {
      name: "start_code_task",
      description:
        `Hand work on code to a background session (several minutes): write code and open a PR, or look into a bug. Describe the request completely: the session sees this conversation, not your memory. Repositories: ${repos.join(", ")}. ` +
        TASK_GUIDE,
      input: {
        request: z.string().min(1),
        title: z.string().max(60).optional().describe("A few words, for a new task"),
        task: z.number().int().optional().describe("The number of the task to continue"),
        new: z.boolean().optional().describe("Start another task even if one is open here"),
        repo: z.string().optional().describe(repos.length > 1 ? `For a new task, required: one of ${repos.join(", ")}` : `For a new task; default ${repos[0] ?? "none"}`),
      },
      rules: ["all"],
      effect: true,
      run: (args, context) =>
        core.startTask(context, {
          request: String(args.request),
          ...(args.title ? { title: String(args.title) } : {}),
          ...(args.task !== undefined ? { task: Number(args.task) } : {}),
          fresh: Boolean(args.new),
          ...(args.repo ? { repo: String(args.repo) } : {}),
        }),
    },
    {
      name: "abandon_code_task",
      description: "Stop a code task for good: its run is cut, its copy and branch stay (a PR stays open on GitHub). Find it in <in_progress> and pass its number as task; in the conversation where it was asked, it is automatic.",
      input: { task: z.number().int().optional().describe("The number of the task to abandon") },
      rules: ["all"],
      effect: true,
      run: (args, context) => core.abandonTask(context, { ...(args.task !== undefined ? { task: Number(args.task) } : {}) }),
    },
  ];
}
