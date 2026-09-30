export const BATCH_USAGE = "Usage: /batch list | status <id> | add <max-runs> -- <task> [-- <task> ...] | run <id> <revision> | recover <id> <revision>.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^(?:0|[1-9][0-9]{0,8})$/;

export type InteractiveBatchCommand =
  | { action: "list" }
  | { action: "status"; id: string }
  | { action: "add"; maxRuns: number; prompts: string[] }
  | { action: "run" | "recover"; id: string; revision: number };

export function parseInteractiveBatchCommand(input: string): InteractiveBatchCommand | undefined {
  if (input === "/batch" || input === "/batch list") return { action: "list" };
  const fields = input.split(/\s+/u);
  if (fields[0] !== "/batch") return undefined;
  if (fields.length === 3 && fields[1] === "status" && ID.test(fields[2]!)) return { action: "status", id: fields[2]! };
  if (fields.length === 4 && fields[1] === "run" && ID.test(fields[2]!) && REVISION.test(fields[3]!))
    return { action: "run", id: fields[2]!, revision: Number(fields[3]) };
  if (fields.length === 4 && fields[1] === "recover" && ID.test(fields[2]!) && REVISION.test(fields[3]!))
    return { action: "recover", id: fields[2]!, revision: Number(fields[3]) };
  if (fields[1] !== "add") return undefined;
  const marker = input.indexOf(" -- ");
  if (marker < 0 || !/^\/batch add [1-8]$/u.test(input.slice(0, marker))) return undefined;
  const prompts = input.slice(marker + 4).split(" -- ").map((part) => part.trim());
  const maxRuns = Number(fields[2]);
  if (!prompts.length || prompts.length > 8 || maxRuns > prompts.length
    || prompts.some((prompt) => !prompt || prompt.length > 1_000 || /[\u0000-\u001f\u007f]/u.test(prompt))) return undefined;
  return { action: "add", maxRuns, prompts };
}
