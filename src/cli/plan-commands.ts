import { createSessionPlanStore, formatPlan, formatPlanHistory, formatRunnablePlan } from "../plan.js";
import type { SessionStore } from "../session-store.js";
import type { CliCommand } from "./commands.js";

export async function runPlanCommand(command: Extract<CliCommand, { kind: "plan" }>, store: SessionStore, write: (text: string) => void): Promise<void> {
  const plans = createSessionPlanStore(store, command.sessionId);
  if (command.action === "list") { write(`${formatPlan(await plans.list())}\n`); return; }
  if (command.action === "runnable") { write(`${formatRunnablePlan(await plans.list())}\n`); return; }
  if (command.action === "history") { write(`${formatPlanHistory(await plans.history())}\n`); return; }
  if (command.action === "add") { const task = await plans.add(command); write(`Added plan task: ${task.id}\n`); return; }
  if (command.action === "update") { const task = await plans.update(command.id, command); write(`Updated plan task: ${task.id}\n`); return; }
  if (command.action === "status") { const task = await plans.setStatus(command.id, command.status, command.blockedReason); write(`Updated plan task status: ${task.id}\n`); return; }
  if (command.action === "recover") { const task = await plans.recoverBlocked(command.id, command.recoveryNote, command.source); write(`Recovered plan task: ${task.id}\n`); return; }
  if (command.action === "replan") { const task = await plans.replan(command.id, { reason: command.reason, replacement: command.replacement }); write(`Replanned plan task: ${task.id}\n`); return; }
  if (command.action === "remove") {
    if (await plans.remove(command.id)) write(`Removed plan task: ${command.id}\n`);
    else write(`Plan task was not found: ${command.id}\n`);
  }
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
  if ((action === "runnable" || action === "history") && values.length === 0) return { kind: "plan", action, sessionId };
  if (action === "add") {
    const description = flag("--description");
    const parent = flag("--parent");
    const dependencies = flag("--depends-on");
    const title = positional.join(" ");
    const dependsOn = dependencies?.flatMap((value) => value.split(",")).filter(Boolean);
    if (title && description?.length && (!parent || parent.length === 1) && (!dependencies || dependsOn?.length)) return { kind: "plan", action, sessionId, title, description: description.join(" "), ...(parent ? { parentId: parent[0]! } : {}), ...(dependsOn === undefined ? {} : { dependsOn }) };
  }
  if (action === "update" && positional.length === 1) {
    const title = flag("--title");
    const description = flag("--description");
    const parent = flag("--parent");
    const dependencies = flag("--depends-on");
    const dependsOn = dependencies?.flatMap((value) => value.split(",")).filter(Boolean);
    const validDependencies = !dependencies || (dependsOn?.length && ((dependsOn.length === 1 && dependsOn[0] === "none") || !dependsOn.includes("none")));
    if ((!title || title.length > 0) && (!description || description.length > 0) && (!parent || parent.length === 1) && validDependencies && (title || description || parent || dependencies)) {
      return { kind: "plan", action, sessionId, id: positional[0]!, ...(title ? { title: title.join(" ") } : {}), ...(description ? { description: description.join(" ") } : {}), ...(parent ? { parentId: parent[0] === "none" ? null : parent[0]! } : {}), ...(dependencies ? { dependsOn: dependsOn![0] === "none" ? null : dependsOn } : {}) };
    }
  }
  if (action === "status" && positional.length === 2) {
    const status = positional[1];
    const reason = flag("--reason");
    if ((status === "TODO" || status === "IN_PROGRESS" || status === "DONE" || status === "BLOCKED") && (!reason || reason.length > 0)) return { kind: "plan", action, sessionId, id: positional[0]!, status, ...(reason ? { blockedReason: reason.join(" ") } : {}) };
  }
  if (action === "recover" && positional.length === 2) {
    const note = flag("--reason");
    const source = positional[1];
    if ((source === "DEPENDENCY_COMPLETED" || source === "USER_INPUT" || source === "CONDITION_RESOLVED") && note?.length) return { kind: "plan", action, sessionId, id: positional[0]!, source, recoveryNote: note.join(" ") };
  }
  if (action === "replan" && positional.length === 1) {
    const reason = flag("--reason");
    const title = flag("--title");
    const description = flag("--description");
    const parent = flag("--parent");
    const dependencies = flag("--depends-on");
    const dependsOn = dependencies?.flatMap((value) => value.split(",")).filter(Boolean);
    if (reason?.length && title?.length && description?.length && (!parent || parent.length === 1) && (!dependencies || dependsOn?.length) && !dependsOn?.includes("none")) return { kind: "plan", action, sessionId, id: positional[0]!, reason: reason.join(" "), replacement: { title: title.join(" "), description: description.join(" "), ...(parent ? { parentId: parent[0]! } : {}), ...(dependsOn === undefined ? {} : { dependsOn }) } };
  }
  if (action === "remove" && positional.length === 1 && values.length === 1) return { kind: "plan", action, sessionId, id: positional[0]! };
  throw new Error("Use /plan [list|runnable|history], /plan add <title> --description <text> [--parent <id>] [--depends-on <id[,id...]>], /plan update <id> [--title <text>] [--description <text>] [--parent <id|none>] [--depends-on <id[,id...]|none>], /plan status <id> <TODO|IN_PROGRESS|DONE|BLOCKED> [--reason <text>], /plan recover <id> <DEPENDENCY_COMPLETED|USER_INPUT|CONDITION_RESOLVED> --reason <text>, /plan replan <id> --reason <text> --title <text> --description <text> [--parent <id>] [--depends-on <id[,id...]>], or /plan remove <id>.");
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
