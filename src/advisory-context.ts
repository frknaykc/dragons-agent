import type { ProjectContext } from "./project-context.js";
import { formatProjectContextForInstructions } from "./project-context.js";
import type { SkillsContext } from "./skills.js";
import { formatSkillsForInstructions } from "./skills.js";
import type { MemoryContext } from "./memory.js";
import { formatMemoryForInstructions } from "./memory.js";
import type { DragonsPlan } from "./plan.js";
import { formatPlanForInstructions } from "./plan.js";
import { DEFAULT_CONTEXT_BUDGET_CHARS } from "./context-budget.js";

export type AdvisoryRequestContext = {
  projectContext?: ProjectContext;
  skills?: SkillsContext;
  memory?: MemoryContext;
  plan?: DragonsPlan;
  contextBudgetChars?: number;
};

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let omitted = value.length;
  for (;;) {
    const marker = `[advisory context truncated; omitted ${omitted} characters]`;
    const retained = Math.max(0, maximum - marker.length);
    const nextOmitted = value.length - retained;
    if (nextOmitted === omitted) return `${value.slice(0, retained)}${marker}`;
    omitted = nextOmitted;
  }
}

/**
 * Provider-neutral ordered advisory context. It is immutable request data, never authority,
 * continuation, or transcript state, and is capped by the existing conservative char budget.
 */
export function formatAdvisoryContextForInstructions(context: AdvisoryRequestContext): string | undefined {
  const maximum = context.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS;
  const sections = [
    formatProjectContextForInstructions(context.projectContext),
    formatSkillsForInstructions(context.skills),
    formatMemoryForInstructions(context.memory),
    formatPlanForInstructions(context.plan),
  ].filter((value): value is string => Boolean(value));
  if (sections.length === 0) return undefined;
  return boundedText(sections.join("\n\n"), maximum);
}
