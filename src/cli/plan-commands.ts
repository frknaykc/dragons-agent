import { createSessionPlanStore, formatPlan } from "../plan.js";
import type { SessionStore } from "../session-store.js";
import type { CliCommand } from "./commands.js";

export async function runPlanCommand(command: Extract<CliCommand, { kind: "plan" }>, store: SessionStore, write: (text: string) => void): Promise<void> {
  const plans = createSessionPlanStore(store, command.sessionId);
  if (command.action === "list") { write(`${formatPlan(await plans.list())}\n`); return; }
  if (command.action === "add") { const task = await plans.add(command); write(`Added plan task: ${task.id}\n`); return; }
  if (command.action === "update") { const task = await plans.update(command.id, command); write(`Updated plan task: ${task.id}\n`); return; }
  if (command.action === "status") { const task = await plans.setStatus(command.id, command.status, command.blockedReason); write(`Updated plan task status: ${task.id}\n`); return; }
  if (await plans.remove(command.id)) write(`Removed plan task: ${command.id}\n`);
  else write(`Plan task was not found: ${command.id}\n`);
}

export function parseInteractivePlanCommand(task: string, sessionId: string): Extract<CliCommand, { kind: "plan" }> {
  const values = task.slice("/plan".length).trim().split(/\s+/).filter(Boolean);
  const action = values.shift();
  const flag = (name: string): string[] | undefined => {
    const index = values.indexOf(name);
    if (index < 0) return undefined;
    const end = values.findIndex((value, candidate) => candidate > index && value.startsWith("--"));
    return values.slice(index + 1, end < 0 ? undefined : end);
  };
  const beforeFlags = values.slice(0, Math.max(0, values.findIndex((value) => value.startsWith("--"))));
  const positional = beforeFlags.length === 0 && !values[0]?.startsWith("--") ? values : beforeFlags;
  if ((action === undefined || action === "list") && values.length === 0) return { kind: "plan", action: "list", sessionId };
  if (action === "add") {
    const description = flag("--description");
    const parent = flag("--parent");
    const title = positional.join(" ");
    if (title && description?.length && (!parent || parent.length === 1)) return { kind: "plan", action, sessionId, title, description: description.join(" "), ...(parent ? { parentId: parent[0]! } : {}) };
  }
  if (action === "update" && positional.length === 1) {
    const title = flag("--title");
    const description = flag("--description");
    const parent = flag("--parent");
    if ((!title || title.length > 0) && (!description || description.length > 0) && (!parent || parent.length === 1) && (title || description || parent)) {
      return { kind: "plan", action, sessionId, id: positional[0]!, ...(title ? { title: title.join(" ") } : {}), ...(description ? { description: description.join(" ") } : {}), ...(parent ? { parentId: parent[0] === "none" ? null : parent[0]! } : {}) };
    }
  }
  if (action === "status" && positional.length === 2) {
    const status = positional[1];
    const reason = flag("--reason");
    if ((status === "TODO" || status === "IN_PROGRESS" || status === "DONE" || status === "BLOCKED") && (!reason || reason.length > 0)) return { kind: "plan", action, sessionId, id: positional[0]!, status, ...(reason ? { blockedReason: reason.join(" ") } : {}) };
  }
  if (action === "remove" && positional.length === 1 && values.length === 1) return { kind: "plan", action, sessionId, id: positional[0]! };
  throw new Error("Use /plan [list], /plan add <title> --description <text> [--parent <id>], /plan update <id> [--title <text>] [--description <text>] [--parent <id|none>], /plan status <id> <TODO|IN_PROGRESS|DONE|BLOCKED> [--reason <text>], or /plan remove <id>.");
}

export async function handleInteractivePlanCommand(input: {
  task: string;
  sessionId: string;
  sessionStore: SessionStore;
  write: (text: string) => void;
}): Promise<boolean> {
  if (!input.task.startsWith("/plan")) return false;
  try { await runPlanCommand(parseInteractivePlanCommand(input.task, input.sessionId), input.sessionStore, input.write); }
  catch (error: unknown) { input.write(`${error instanceof Error ? error.message : "Unable to update plan."}\n`); }
  return true;
}
