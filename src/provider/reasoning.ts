import type { ReasoningEffort } from "openai/resources/shared.js";

/** Wire values, not UI synonyms. `default` is a local reset, never sent. */
export type ReasoningLevel = Exclude<ReasoningEffort, null>;
export type ReasoningModels = Readonly<Record<string, readonly ReasoningLevel[]>>;
export type ReasoningPreferences = Record<string, Record<string, ReasoningLevel>>;
export const REASONING_LEVELS: readonly ReasoningLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Exact IDs only: no prefix inference or claims about account entitlement.
 * Verified 2026-09-10 against installed openai 7.9+ shared.ReasoningEffort and
 * https://developers.openai.com/api/docs/models/{gpt-5,gpt-5.4,gpt-5.5,gpt-5.6-terra}
 * Those model pages explicitly enumerate these effort values (including terra's max).
 * No mapping for unknown models, Anthropic budgets, Gemini thinking or routed aliases.
 */
export const OPENAI_REASONING_MODELS: ReasoningModels = Object.freeze({
  "gpt-5": Object.freeze(["minimal", "low", "medium", "high"] as const),
  "gpt-5.4": Object.freeze(["none", "low", "medium", "high", "xhigh"] as const),
  "gpt-5.5": Object.freeze(["none", "low", "medium", "high", "xhigh"] as const),
  "gpt-5.6-terra": Object.freeze(["none", "low", "medium", "high", "xhigh", "max"] as const),
});

export function reasoningLevels(models: ReasoningModels | undefined, model: string): readonly ReasoningLevel[] {
  return models && Object.hasOwn(models, model) ? models[model]! : [];
}
export function validateReasoning(models: ReasoningModels | undefined, model: string, level: string): ReasoningLevel {
  if (!reasoningLevels(models, model).includes(level as ReasoningLevel)) throw new Error("Reasoning level is unsupported or unverified for this provider/model.");
  return level as ReasoningLevel;
}
export function openAIReasoning(model: string, level?: ReasoningLevel): { effort: ReasoningLevel } | undefined {
  return level === undefined ? undefined : { effort: validateReasoning(OPENAI_REASONING_MODELS, model, level) };
}
export function parseReasoningPreferences(value: unknown, providerIds: readonly string[]): ReasoningPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) throw new Error("Dragons config reasoning must be a bounded provider/model map.");
  const result: ReasoningPreferences = Object.create(null) as ReasoningPreferences;
  for (const [provider, models] of Object.entries(value)) {
    if (!providerIds.includes(provider) || !models || typeof models !== "object" || Array.isArray(models) || Object.keys(models).length > 128) throw new Error("Dragons config reasoning has an invalid provider/model map.");
    const entries = Object.entries(models as Record<string, unknown>);
    for (const [model, level] of entries) {
      if (!/^[\x21-\x7e]{1,256}$/.test(model) || ["__proto__", "constructor", "prototype"].includes(model) || !REASONING_LEVELS.includes(level as ReasoningLevel)) throw new Error("Dragons config reasoning has an invalid model or effort.");
    }
    result[provider] = Object.fromEntries(entries) as Record<string, ReasoningLevel>;
  }
  return result;
}
