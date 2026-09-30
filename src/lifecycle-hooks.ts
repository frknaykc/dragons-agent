import type { AgentTool } from "./tools.js";

export type LifecycleEventName = "session_started" | "turn_started" | "turn_completed" | "tool_started" | "tool_completed" | "file_changed";

/** Trusted-host configuration. Each trigger invokes an existing registered tool via runAgent's approval path. */
export type LifecycleHook = {
  on: LifecycleEventName;
  toolName: string;
  /** Static JSON arguments; event metadata is added under `event`. Never include secrets. */
  arguments?: Record<string, unknown>;
};

export type LifecycleEvent = {
  type: LifecycleEventName;
  toolName?: string;
  path?: string;
  ok?: boolean;
};

const EVENTS = new Set<LifecycleEventName>(["session_started", "turn_started", "turn_completed", "tool_started", "tool_completed", "file_changed"]);

/** Copy and validate before a run starts, so mutable host input cannot change its authority mid-run. */
export function prepareLifecycleHooks(input: readonly LifecycleHook[] | undefined, tools: readonly AgentTool[]): ReadonlyArray<Readonly<LifecycleHook & { arguments: Record<string, unknown> }>> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 16) throw new Error("Lifecycle hooks must be an array of at most 16 bindings.");
  const names = new Set(tools.map((tool) => tool.name));
  return input.map((hook) => {
    if (!hook || typeof hook !== "object" || !EVENTS.has(hook.on) || typeof hook.toolName !== "string" || !names.has(hook.toolName)) {
      throw new Error("Lifecycle hook references an invalid event or unavailable tool.");
    }
    const args = hook.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.getPrototypeOf(args) !== Object.prototype) {
      throw new Error("Lifecycle hook arguments must be a plain object.");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      throw new Error("Lifecycle hook arguments must be serializable JSON.");
    }
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 4096 || Object.keys(JSON.parse(serialized) as object).includes("event")) {
      throw new Error("Lifecycle hook arguments exceed the limit or reserve the event key.");
    }
    return { on: hook.on, toolName: hook.toolName, arguments: JSON.parse(serialized) as Record<string, unknown> };
  });
}
