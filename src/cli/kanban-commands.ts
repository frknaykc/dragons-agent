import type { KanbanBoard, KanbanStatus, KanbanTask } from "../kanban.js";
import { isSafeProfileName } from "../profiles.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^(?:0|[1-9][0-9]{0,8})$/;
const PID = /^[1-9][0-9]{0,8}$/;
const PERCENT = /^(?:100|[1-9]?[0-9])$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export const KANBAN_USAGE = "Usage: /kanban [list|status <id>|add <assignee> -- <title>|assign <id> <revision> <assignee>|depend <id> <revision> <dependency-id>|progress <id> <revision> <todo|doing|blocked|done> <0-100>|handoff offer <id> <revision> <profile>|handoff accept <id> <revision>|handoff cancel <id> <revision>|lock status|lock recover|lane lock status|lane lock recover|worker recover <id> <revision> <pid>|worker start <id> <revision>|worker lane <id>:<revision> [<id>:<revision> ...]].";

/** Explicit one-shot launch, parsed separately from ordinary board commands. */
export function parseKanbanWorkerStart(input: string): { id: string; revision: number } | undefined {
  const parts = input.split(/\s+/u);
  if (parts.length !== 5 || parts[0] !== "/kanban" || parts[1] !== "worker" || parts[2] !== "start"
    || !ID.test(parts[3]!) || !REVISION.test(parts[4]!)) return undefined;
  return { id: parts[3]!, revision: Number(parts[4]) };
}

/** Only explicit task IDs and revisions; the host supplies the actor and workspace. */
export function parseKanbanWorkerLane(input: string): { id: string; revision: number }[] | undefined {
  const parts = input.split(/\s+/u);
  if (parts.length < 4 || parts.length > 11 || parts[0] !== "/kanban"
    || parts[1] !== "worker" || parts[2] !== "lane") return undefined;
  const tasks: { id: string; revision: number }[] = [];
  const seen = new Set<string>();
  for (const part of parts.slice(3)) {
    const separator = part.lastIndexOf(":");
    const id = part.slice(0, separator);
    const revision = part.slice(separator + 1);
    if (!ID.test(id) || !REVISION.test(revision) || seen.has(id)) return undefined;
    tasks.push({ id, revision: Number(revision) });
    seen.add(id);
  }
  return tasks;
}

export type InteractiveKanbanCommand =
  | { action: "list" }
  | { action: "status"; id: string }
  | { action: "add"; assignee: string; title: string }
  | { action: "assign"; id: string; revision: number; assignee: string }
  | { action: "depend"; id: string; revision: number; dependencyId: string }
  | { action: "progress"; id: string; revision: number; status: KanbanStatus; progress: number }
  | { action: "handoff_offer"; id: string; revision: number; target: string }
  | { action: "handoff_accept" | "handoff_cancel"; id: string; revision: number }
  | { action: "worker_recover"; id: string; revision: number; pid: number };

/** Parse locally: board operations never become model prompts or agent tools. */
export function parseInteractiveKanbanCommand(input: string): InteractiveKanbanCommand | undefined {
  if (input === "/kanban" || input === "/kanban list") return { action: "list" };
  const add = /^\/kanban add (\S+) -- (.+)$/u.exec(input);
  if (add) {
    const title = add[2]!.trim();
    if (isSafeProfileName(add[1]!) && title && !CONTROL_CHARACTER.test(title) && Buffer.byteLength(title, "utf8") <= 240)
      return { action: "add", assignee: add[1]!, title };
    return undefined;
  }
  const parts = input.split(/\s+/u);
  if (parts[0] !== "/kanban") return undefined;
  if (parts[1] === "status" && parts.length === 3 && ID.test(parts[2]!)) return { action: "status", id: parts[2]! };
  if (parts[1] === "handoff" && ID.test(parts[3] ?? "") && REVISION.test(parts[4] ?? "")) {
    if (parts[2] === "offer" && parts.length === 6 && isSafeProfileName(parts[5]!))
      return { action: "handoff_offer", id: parts[3]!, revision: Number(parts[4]), target: parts[5]! };
    if (parts[2] === "accept" && parts.length === 5)
      return { action: "handoff_accept", id: parts[3]!, revision: Number(parts[4]) };
    if (parts[2] === "cancel" && parts.length === 5)
      return { action: "handoff_cancel", id: parts[3]!, revision: Number(parts[4]) };
    return undefined;
  }
  if (parts[1] === "worker" && parts[2] === "recover" && parts.length === 6
    && ID.test(parts[3]!) && REVISION.test(parts[4]!) && PID.test(parts[5]!))
    return { action: "worker_recover", id: parts[3]!, revision: Number(parts[4]), pid: Number(parts[5]) };
  if (!ID.test(parts[2] ?? "") || !REVISION.test(parts[3] ?? "")) return undefined;
  const id = parts[2]!;
  const revision = Number(parts[3]);
  if (parts[1] === "assign" && parts.length === 5 && isSafeProfileName(parts[4]!))
    return { action: "assign", id, revision, assignee: parts[4]! };
  if (parts[1] === "depend" && parts.length === 5 && ID.test(parts[4]!))
    return { action: "depend", id, revision, dependencyId: parts[4]! };
  if (parts[1] === "progress" && parts.length === 6 && ["todo", "doing", "blocked", "done"].includes(parts[4]!)
    && PERCENT.test(parts[5]!) && (parts[4] === "done") === (parts[5] === "100"))
    return { action: "progress", id, revision, status: parts[4] as KanbanStatus, progress: Number(parts[5]) };
  return undefined;
}

function summarize(task: KanbanTask): string {
  return `${task.id} revision ${task.revision} ${task.status} ${task.progress}% assignee ${task.assignee}${task.handoffTo ? ` handoff offered to ${task.handoffTo}` : ""}: ${task.title}`;
}

export async function runInteractiveKanbanCommand(board: KanbanBoard, actor: string, command: InteractiveKanbanCommand): Promise<string> {
  switch (command.action) {
    case "list": {
      const tasks = await board.list(actor);
      return tasks.length ? `Kanban tasks:\n${tasks.map(summarize).join("\n")}` : "No Kanban tasks in this workspace.";
    }
    case "status": {
      const task = await board.get(actor, command.id);
      return task ? `${summarize(task)}\nCreator: ${task.createdBy}\nDepends on: ${task.dependsOn.join(", ") || "none"}${task.worker ? `\nWorker PID ${task.worker.pid} on ${JSON.stringify(task.worker.host)} (${task.worker.profile})` : ""}` : "Kanban task not found.";
    }
    case "add": {
      const task = await board.create(actor, command.title, command.assignee, []);
      return `Kanban task created: ${task.id} revision ${task.revision}`;
    }
    case "assign": return `Kanban task ${summarize(await board.assign(actor, command.id, command.revision, command.assignee))}`;
    case "depend": return `Kanban task ${summarize(await board.addDependency(actor, command.id, command.revision, command.dependencyId))}`;
    case "progress": return `Kanban task ${summarize(await board.updateProgress(actor, command.id, command.revision, command.status, command.progress))}`;
    case "handoff_offer": return `Kanban task ${summarize(await board.offerHandoff(actor, command.id, command.revision, command.target))}`;
    case "handoff_accept": return `Kanban task ${summarize(await board.acceptHandoff(actor, command.id, command.revision))}`;
    case "handoff_cancel": return `Kanban task ${summarize(await board.cancelHandoff(actor, command.id, command.revision))}`;
    case "worker_recover": throw new Error("Kanban worker recovery requires CLI confirmation.");
  }
}
