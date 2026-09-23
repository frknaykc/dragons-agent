export const MAX_CATALOGUE_MODELS = 128;
export type ModelCatalogue = readonly string[];

/** Exact wire IDs only: never trim, rewrite aliases, or infer reasoning support. */
export function isCatalogueModelId(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value)
    && !["__proto__", "prototype", "constructor"].includes(value);
}

export function validateModelCatalogue(value: unknown): asserts value is ModelCatalogue {
  if (!Array.isArray(value) || value.length > MAX_CATALOGUE_MODELS
    || [...value].some((id) => !isCatalogueModelId(id)) || new Set(value).size !== value.length) {
    throw new Error("Model catalogue must contain at most 128 unique safe model IDs.");
  }
}

/**
 * Curated catalogue, not a complete list, account entitlement, or live availability.
 * Source IDs checked 2026-09-10. No credentials or network calls at picker time.
 * OpenAI: https://developers.openai.com/api/docs/models/gpt-4.1-mini
 *         https://developers.openai.com/api/docs/models/gpt-5.4
 * Codex:  https://developers.openai.com/codex/models
 * Anthropic (official SDK Model union; docs returned 403):
 * https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
 * Gemini: https://ai.google.dev/gemini-api/docs/models
 * OpenRouter: https://openrouter.ai/api/v1/models (public catalogue, exact routed IDs)
 * No existing adapter exposes safe model discovery. Local installations are unknown.
 */
export const BUILTIN_MODEL_CATALOGUES: Readonly<Record<string, ModelCatalogue>> = Object.freeze({
  "openai-api": Object.freeze(["gpt-4.1-mini", "gpt-5.4"]),
  chatgpt: Object.freeze(["gpt-5.6-terra", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex"]),
  anthropic: Object.freeze(["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"]),
  gemini: Object.freeze(["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"]),
  openrouter: Object.freeze(["openai/gpt-4.1-mini", "openai/gpt-4.1", "google/gemini-2.5-flash"]),
});

/** Treat transported metadata defensively; invalid IDs are omitted, never repaired. */
export function modelCatalogueChoices(provider: { defaultModel: string; modelCatalogue?: ModelCatalogue }, configuredModel?: string): { value: string; description: string }[] {
  const candidates = [configuredModel, provider.defaultModel,
    ...(Array.isArray(provider.modelCatalogue) ? provider.modelCatalogue.slice(0, MAX_CATALOGUE_MODELS) : [])];
  const seen = new Set<string>();
  return candidates.filter((id): id is string => {
    if (!isCatalogueModelId(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((value) => ({
    value,
    description: `${value === configuredModel ? "Configured model" : value === provider.defaultModel ? "Adapter default" : "Known model catalogue"}; access not verified. Custom model IDs may be typed.`,
  }));
}
