import type { PlanMutationSource, PlanTaskStatus } from "../plan.js";
import { DEFAULT_PROVIDER_IDS, type ProviderId } from "../provider/registry.js";

export type ProviderName = ProviderId;


export type CliCommand =
  | { kind: "run"; provider: ProviderName; model?: string; prompt?: string }
  | { kind: "auth"; action: "login" | "status" | "logout" }
  | { kind: "config"; action: "show" }
  | { kind: "config"; action: "set-provider"; provider: ProviderName }
  | { kind: "config"; action: "set-model"; provider: ProviderName; model: string }
  | { kind: "config"; action: "set-local-endpoint"; endpoint: string }
  | { kind: "config"; action: "reset"; target: "provider" | "model" }
  | { kind: "session"; action: "list" }
  | { kind: "session"; action: "show"; id: string }
  | { kind: "session"; action: "delete"; id: string }
  | { kind: "session"; action: "resume"; id: string }
  | { kind: "skills"; action: "list" }
  | { kind: "skills"; action: "show"; id: string; scope?: "project" }
  | { kind: "skills"; action: "activate" | "deactivate"; id: string; sessionId: string; scope?: "project" }
  | { kind: "memory"; action: "list"; scope: "user" | "project" }
  | { kind: "memory"; action: "show"; id: string; scope: "user" | "project" }
  | { kind: "memory"; action: "add"; body: string; scope: "user" | "project" }
  | { kind: "memory"; action: "suggest"; body: string; scope: "user" | "project" }
  | { kind: "memory"; action: "delete"; id: string; scope: "user" | "project" }
  | { kind: "memory"; action: "update"; id: string; body: string; scope: "user" | "project" }
  | { kind: "memory"; action: "expire"; id: string; expiresAt: string; scope: "user" | "project" }
  | { kind: "memory"; action: "cleanup"; scope: "user" | "project" }
  | { kind: "plan"; action: "list"; sessionId: string }
  | { kind: "plan"; action: "runnable" | "history"; sessionId: string }
  | { kind: "plan"; action: "add"; sessionId: string; title: string; description: string; parentId?: string; dependsOn?: string[] }
  | { kind: "plan"; action: "update"; sessionId: string; id: string; title?: string; description?: string; parentId?: string | null; dependsOn?: string[] | null }
  | { kind: "plan"; action: "status"; sessionId: string; id: string; status: PlanTaskStatus; blockedReason?: string }
  | { kind: "plan"; action: "recover"; sessionId: string; id: string; recoveryNote: string; source: Exclude<PlanMutationSource, "PLAN_REVISION"> }
  | { kind: "plan"; action: "replan"; sessionId: string; id: string; reason: string; replacement: { title: string; description: string; parentId?: string; dependsOn?: string[] } }
  | { kind: "plan"; action: "remove"; sessionId: string; id: string }
  | { kind: "mcp"; action: "list" }
  | { kind: "mcp"; action: "status" }
  | { kind: "mcp"; action: "connect-all" }
  | { kind: "mcp"; action: "connect"; id: string }
  | { kind: "mcp"; action: "disconnect"; id: string };

export function providerFrom(value: string, providerIds: readonly ProviderId[] = DEFAULT_PROVIDER_IDS): ProviderName {
  if (providerIds.includes(value)) return value;
  throw new Error(`Unknown provider. Use ${providerIds.join(", ") || "a registered provider"}.`);
}

function parseRunCommand(arguments_: string[], providerIds: readonly ProviderId[]): CliCommand {
  const defaultProvider = providerIds.includes("openai-api") ? "openai-api" : providerIds[0];
  if (!defaultProvider) throw new Error("No providers are registered.");
  let provider: ProviderName = defaultProvider;
  let model: string | undefined;
  const prompt: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--provider") {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`--provider requires ${providerIds.join(", ") || "a registered provider"}.`);
      provider = providerFrom(value, providerIds);
      index += 1;
      continue;
    }
    if (argument === "--model") {
      const value = arguments_[index + 1]?.trim();
      if (!value) throw new Error("--model requires a model name.");
      model = value;
      index += 1;
      continue;
    }
    prompt.push(argument);
  }
  const task = prompt.join(" ").trim();
  return { kind: "run", provider, model, prompt: task || undefined };
}

function parsePlanCommand(arguments_: string[]): Extract<CliCommand, { kind: "plan" }> {
  const sessionIndex = arguments_.lastIndexOf("--session");
  if (sessionIndex < 0 || sessionIndex !== arguments_.length - 2 || !arguments_[sessionIndex + 1]) {
    throw new Error("Every plan command requires --session <id>.");
  }
  const sessionId = arguments_[sessionIndex + 1]!;
  const action = arguments_[1];
  const values = arguments_.slice(2, sessionIndex);
  if ((action === "list" || action === "runnable" || action === "history") && values.length === 0) return { kind: "plan", action, sessionId };
  if (action === "add") {
    const parentIndex = values.indexOf("--parent");
    const dependenciesIndex = values.indexOf("--depends-on");
    const firstFlag = [parentIndex, dependenciesIndex].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? -1;
    const core = firstFlag < 0 ? values : values.slice(0, firstFlag);
    const parentId = parentIndex < 0 ? undefined : values[parentIndex + 1];
    const dependencyList = dependenciesIndex < 0 ? undefined : values[dependenciesIndex + 1]?.split(",").filter(Boolean);
    const expectedLength = 2 + (parentIndex < 0 ? 0 : 2) + (dependenciesIndex < 0 ? 0 : 2);
    if (core.length === 2 && values.length === expectedLength && (parentIndex < 0 || parentId) && (dependenciesIndex < 0 || dependencyList?.length)) {
      return { kind: "plan", action, sessionId, title: core[0]!, description: core[1]!, ...(parentId === undefined ? {} : { parentId }), ...(dependencyList === undefined ? {} : { dependsOn: dependencyList }) };
    }
  }
  if (action === "update" && values[0]) {
    const id = values[0];
    const updates: { title?: string; description?: string; parentId?: string | null; dependsOn?: string[] | null } = {};
    for (let index = 1; index < values.length; index += 2) {
      const flag = values[index];
      const value = values[index + 1];
      if (!value || (flag !== "--title" && flag !== "--description" && flag !== "--parent" && flag !== "--depends-on")) throw new Error("Use --title <text>, --description <text>, --parent <id|none>, and/or --depends-on <id[,id... ]|none>.");
      if (flag === "--title") updates.title = value;
      if (flag === "--description") updates.description = value;
      if (flag === "--parent") updates.parentId = value === "none" ? null : value;
      if (flag === "--depends-on") {
        const dependsOn = value === "none" ? null : value.split(",").filter(Boolean);
        if (dependsOn !== null && dependsOn.length === 0) throw new Error("--depends-on requires one or more task IDs, or none.");
        updates.dependsOn = dependsOn;
      }
    }
    if (values.length > 1 && Object.keys(updates).length > 0) return { kind: "plan", action, sessionId, id, ...updates };
  }
  if (action === "status" && values[0] && values[1] && (values.length === 2 || (values.length === 4 && values[2] === "--reason" && values[3]))) {
    const status = values[1];
    if (status === "TODO" || status === "IN_PROGRESS" || status === "DONE" || status === "BLOCKED") {
      return { kind: "plan", action, sessionId, id: values[0], status, ...(values[3] === undefined ? {} : { blockedReason: values[3] }) };
    }
  }
  if (action === "recover" && values[0] && values[1] && values[2] && values.length === 3 && (values[1] === "DEPENDENCY_COMPLETED" || values[1] === "USER_INPUT" || values[1] === "CONDITION_RESOLVED")) return { kind: "plan", action, sessionId, id: values[0], source: values[1], recoveryNote: values[2] };
  if (action === "replan") {
    const parentIndex = values.indexOf("--parent");
    const dependenciesIndex = values.indexOf("--depends-on");
    const firstFlag = [parentIndex, dependenciesIndex].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? -1;
    const core = firstFlag < 0 ? values : values.slice(0, firstFlag);
    const parentId = parentIndex < 0 ? undefined : values[parentIndex + 1];
    const dependsOn = dependenciesIndex < 0 ? undefined : values[dependenciesIndex + 1]?.split(",").filter(Boolean);
    const expectedLength = 4 + (parentIndex < 0 ? 0 : 2) + (dependenciesIndex < 0 ? 0 : 2);
    if (core.length === 4 && values.length === expectedLength && (parentIndex < 0 || parentId) && (dependenciesIndex < 0 || dependsOn?.length)) return { kind: "plan", action, sessionId, id: core[0]!, reason: core[1]!, replacement: { title: core[2]!, description: core[3]!, ...(parentId === undefined ? {} : { parentId }), ...(dependsOn === undefined ? {} : { dependsOn }) } };
  }
  if (action === "remove" && values.length === 1) return { kind: "plan", action, sessionId, id: values[0]! };
  throw new Error("Use dragons plan list|runnable|history --session <id>, plan add <title> <description> [--parent <id>] [--depends-on <id[,id...]>] --session <id>, plan update <id> [--title <text>] [--description <text>] [--parent <id|none>] [--depends-on <id[,id...]|none>] --session <id>, plan status <id> <TODO|IN_PROGRESS|DONE|BLOCKED> [--reason <text>] --session <id>, plan recover <id> <DEPENDENCY_COMPLETED|USER_INPUT|CONDITION_RESOLVED> <note> --session <id>, plan replan <id> <reason> <replacement-title> <replacement-description> [--parent <id>] [--depends-on <id[,id...]>] --session <id>, or plan remove <id> --session <id>.");
}

export function parseCliCommand(arguments_: string[], providerIds: readonly ProviderId[] = DEFAULT_PROVIDER_IDS): CliCommand {
  const forwardedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (forwardedArguments[0] === "plan") return parsePlanCommand(forwardedArguments);
  if (forwardedArguments[0] === "mcp") {
    if ((forwardedArguments[1] === "list" || forwardedArguments[1] === "status") && forwardedArguments.length === 2) return { kind: "mcp", action: forwardedArguments[1] };
    if (forwardedArguments[1] === "connect-all" && forwardedArguments.length === 2) return { kind: "mcp", action: "connect-all" };
    if ((forwardedArguments[1] === "connect" || forwardedArguments[1] === "disconnect") && forwardedArguments[2] && forwardedArguments.length === 3) return { kind: "mcp", action: forwardedArguments[1], id: forwardedArguments[2] };
    throw new Error("Use dragons mcp list, dragons mcp connect <id>, dragons mcp connect-all, dragons mcp status, or dragons mcp disconnect <id>.");
  }
  if (forwardedArguments[0] === "memory") {
    const scope = forwardedArguments[2] === "project" ? "project" : "user";
    if (forwardedArguments[1] === "list" && (forwardedArguments.length === 2 || (forwardedArguments.length === 3 && (forwardedArguments[2] === "user" || forwardedArguments[2] === "project")))) return { kind: "memory", action: "list", scope };
    if (forwardedArguments[1] === "show" && forwardedArguments[2] && (forwardedArguments.length === 3 || (forwardedArguments.length === 4 && (forwardedArguments[3] === "user" || forwardedArguments[3] === "project")))) return { kind: "memory", action: "show", id: forwardedArguments[2], scope: forwardedArguments[3] === "project" ? "project" : "user" };
    if (forwardedArguments[1] === "add" && forwardedArguments.length >= 3) {
      const explicitScope = forwardedArguments[2] === "user" || forwardedArguments[2] === "project" ? forwardedArguments[2] : "user";
      const body = forwardedArguments.slice(explicitScope === "user" && forwardedArguments[2] !== "user" ? 2 : 3).join(" ").trim();
      if (body) return { kind: "memory", action: "add", body, scope: explicitScope };
    }
    if (forwardedArguments[1] === "suggest" && forwardedArguments.length >= 3) {
      const explicitScope = forwardedArguments[2] === "user" || forwardedArguments[2] === "project" ? forwardedArguments[2] : "user";
      const body = forwardedArguments.slice(explicitScope === "user" && forwardedArguments[2] !== "user" ? 2 : 3).join(" ").trim();
      if (body) return { kind: "memory", action: "suggest", body, scope: explicitScope };
    }
    if (forwardedArguments[1] === "delete" && forwardedArguments[2] && (forwardedArguments.length === 3 || (forwardedArguments.length === 4 && (forwardedArguments[3] === "user" || forwardedArguments[3] === "project")))) return { kind: "memory", action: "delete", id: forwardedArguments[2], scope: forwardedArguments[3] === "project" ? "project" : "user" };
    if (forwardedArguments[1] === "update" && forwardedArguments[2] && forwardedArguments.length >= 4) {
      const explicitScope = forwardedArguments[3] === "user" || forwardedArguments[3] === "project" ? forwardedArguments[3] : "user";
      const body = forwardedArguments.slice(explicitScope === "user" && forwardedArguments[3] !== "user" ? 3 : 4).join(" ").trim();
      if (body) return { kind: "memory", action: "update", id: forwardedArguments[2], body, scope: explicitScope };
    }
    if (forwardedArguments[1] === "expire" && forwardedArguments[2] && forwardedArguments[3] && (forwardedArguments.length === 4 || (forwardedArguments.length === 5 && (forwardedArguments[4] === "user" || forwardedArguments[4] === "project")))) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(forwardedArguments[3]) || !Number.isFinite(Date.parse(forwardedArguments[3]))) throw new Error("Memory expiration must be a valid ISO-8601 timestamp.");
      return { kind: "memory", action: "expire", id: forwardedArguments[2], expiresAt: forwardedArguments[3], scope: forwardedArguments[4] === "project" ? "project" : "user" };
    }
    if (forwardedArguments[1] === "cleanup" && (forwardedArguments.length === 2 || (forwardedArguments.length === 3 && (forwardedArguments[2] === "user" || forwardedArguments[2] === "project")))) return { kind: "memory", action: "cleanup", scope };
    throw new Error("Use dragons memory list [user|project], show <id> [user|project], add [user|project] <body>, suggest [user|project] <body>, update <id> [user|project] <body>, expire <id> <ISO-8601> [user|project], cleanup [user|project], or delete <id> [user|project].");
  }
  if (forwardedArguments[0] === "skills") {
    if (forwardedArguments[1] === "list" && forwardedArguments.length === 2) return { kind: "skills", action: "list" };
    if (forwardedArguments[1] === "show" && forwardedArguments[2] && (forwardedArguments.length === 3 || (forwardedArguments.length === 4 && forwardedArguments[3] === "project"))) return { kind: "skills", action: "show", id: forwardedArguments[2], ...(forwardedArguments[3] === "project" ? { scope: "project" } : {}) };
    if ((forwardedArguments[1] === "activate" || forwardedArguments[1] === "deactivate") && forwardedArguments[2] && forwardedArguments[3] === "--session" && forwardedArguments[4] && forwardedArguments.length === 5) {
      return { kind: "skills", action: forwardedArguments[1], id: forwardedArguments[2], sessionId: forwardedArguments[4] };
    }
    if ((forwardedArguments[1] === "activate" || forwardedArguments[1] === "deactivate") && forwardedArguments[2] && forwardedArguments[3] === "project" && forwardedArguments[4] === "--session" && forwardedArguments[5] && forwardedArguments.length === 6) {
      return { kind: "skills", action: forwardedArguments[1], id: forwardedArguments[2], scope: "project", sessionId: forwardedArguments[5] };
    }
    throw new Error("Use dragons skills list, dragons skills show <id> [project], or dragons skills activate|deactivate <id> [project] --session <id>.");
  }
  if (forwardedArguments[0] === "session") {
    if (forwardedArguments[1] === "list" && forwardedArguments.length === 2) return { kind: "session", action: "list" };
    if ((forwardedArguments[1] === "resume" || forwardedArguments[1] === "show" || forwardedArguments[1] === "delete") && forwardedArguments[2] && forwardedArguments.length === 3) {
      return { kind: "session", action: forwardedArguments[1], id: forwardedArguments[2] };
    }
    throw new Error("Use dragons session list, dragons session show <id>, dragons session delete <id>, or dragons session resume <id>.");
  }
  if (forwardedArguments[0] === "config") {
    if (forwardedArguments[1] === "show" && forwardedArguments.length === 2) return { kind: "config", action: "show" };
    if (forwardedArguments[1] === "set-provider" && forwardedArguments[2] && forwardedArguments.length === 3) return { kind: "config", action: "set-provider", provider: providerFrom(forwardedArguments[2], providerIds) };
    if (forwardedArguments[1] === "set-model" && forwardedArguments[2] && forwardedArguments[3]?.trim() && forwardedArguments.length === 4) return { kind: "config", action: "set-model", provider: providerFrom(forwardedArguments[2], providerIds), model: forwardedArguments[3].trim() };
    if (forwardedArguments[1] === "set-local-endpoint" && forwardedArguments[2]?.trim() && forwardedArguments.length === 3) return { kind: "config", action: "set-local-endpoint", endpoint: forwardedArguments[2].trim() };
    if (forwardedArguments[1] === "reset" && (forwardedArguments[2] === "provider" || forwardedArguments[2] === "model") && forwardedArguments.length === 3) return { kind: "config", action: "reset", target: forwardedArguments[2] };
    throw new Error("Use dragons config show, set-provider <provider>, set-model <provider> <model>, set-local-endpoint <url>, or reset <provider|model>.");
  }
  if (forwardedArguments[0] !== "auth") return parseRunCommand(forwardedArguments, providerIds);
  const action = forwardedArguments[1];
  if (action !== "login" && action !== "status" && action !== "logout") {
    throw new Error("Use dragons auth login --provider chatgpt, dragons auth status, or dragons auth logout --provider chatgpt.");
  }
  const providerIndex = forwardedArguments.indexOf("--provider");
  const provider = providerIndex === -1 ? undefined : forwardedArguments[providerIndex + 1];
  if ((action === "login" || action === "logout") && provider !== "chatgpt") {
    throw new Error(`dragons auth ${action} requires --provider chatgpt.`);
  }
  if (action === "status" && provider && provider !== "chatgpt") {
    throw new Error("dragons auth status supports only --provider chatgpt.");
  }
  return { kind: "auth", action };
}
