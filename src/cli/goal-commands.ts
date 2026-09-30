import { GOAL_ID } from "../persistent-goals.js";
import type { PersistentGoalCommand } from "../persistent-goal-service.js";

export const GOAL_USAGE = "Usage: /goal list | status|run|pause|resume|complete|interrupt <id> | add <max-turns> <UTC ISO deadline> -- <objective> -- <completion criterion>.";

/** Parse only a local interactive command; the service validates ownership and budgets. */
export function parseInteractiveGoalCommand(content: string, sessionId: string): PersistentGoalCommand | undefined {
  const args = content.trim().split(/\s+/).slice(1);
  const action = args[0] ?? "list";
  if (action === "list" && args.length <= 1) return { action, sessionId };
  if ((action === "status" || action === "run" || action === "pause" || action === "resume" || action === "complete" || action === "interrupt")
    && args.length === 2 && GOAL_ID.test(args[1]!)) return { action, sessionId, id: args[1]! };
  if (action !== "add") return undefined;
  const first = content.indexOf(" -- ");
  const second = first < 0 ? -1 : content.indexOf(" -- ", first + 4);
  const fields = first < 0 ? [] : content.slice(0, first).trim().split(/\s+/);
  const objective = second < 0 ? "" : content.slice(first + 4, second).trim();
  const criterion = second < 0 ? "" : content.slice(second + 4).trim();
  if (fields.length !== 4 || !/^[1-9][0-9]{0,1}$/.test(fields[2]!) || !objective || !criterion
    || objective.length > 4_000 || criterion.length > 1_000 || /[\u0000-\u001f\u007f]/.test(objective + criterion)) return undefined;
  return { action, sessionId, maxTurns: Number(fields[2]), deadlineAt: fields[3]!, objective, criterion };
}
