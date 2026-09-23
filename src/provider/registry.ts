import { parseReasoningPreferences, reasoningLevels, validateReasoning, type ReasoningLevel, type ReasoningModels, type ReasoningPreferences } from "./reasoning.js";
import { isCatalogueModelId, validateModelCatalogue, type ModelCatalogue } from "./model-catalogue.js";
import type { AgentModel } from "../agent.js";
import { createFallbackModel, type AdoptFallbackIdentity, type ProviderFallbackConfiguration } from "./fallback.js";

export type ProviderId = string;
export const DEFAULT_PROVIDER_IDS = ["openai-api", "chatgpt", "anthropic", "gemini", "openrouter", "local"] as const;

export type ProviderCredentialRequirement = "api-key" | "oauth" | "none";

export type ProviderCapabilities = Readonly<{
  streaming: boolean;
  toolCalls: boolean;
  toolResultContinuation: boolean;
  usageMetadata: boolean;
}>;

export type ProviderModelFactoryContext = Readonly<{
  model?: string;
  reasoning?: ReasoningLevel;
  /** CLI-only output capability; never persisted or forwarded to a provider request. */
  write?: (text: string) => void;
}>;

export type ProviderDescriptor = Readonly<{
  id: ProviderId;
  label: string;
  defaultModel: string;
  credentialRequirement: ProviderCredentialRequirement;
  capabilities: ProviderCapabilities;
  reasoningModels?: ReasoningModels;
  /** Curated IDs, not account entitlement; no discovery or credential access. */
  modelCatalogue?: ModelCatalogue;
  /** Creates isolated model state for one Dragons run, session, child, or background job. */
  createModel: (context: ProviderModelFactoryContext) => AgentModel;
}>;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PROVIDER_LABEL = /^[\x20-\x7e]{1,128}$/;
const PROVIDER_DESCRIPTOR_KEYS = new Set(["id", "label", "defaultModel", "credentialRequirement", "capabilities", "reasoningModels", "modelCatalogue", "createModel"]);
const PROVIDER_CAPABILITY_KEYS = new Set(["streaming", "toolCalls", "toolResultContinuation", "usageMetadata"]);

function validateDescriptor(descriptor: ProviderDescriptor): void {
  if (Reflect.ownKeys(descriptor).some((key) => typeof key !== "string" || !PROVIDER_DESCRIPTOR_KEYS.has(key))) {
    throw new Error("Provider descriptor contains unexpected properties.");
  }
  if (!PROVIDER_ID.test(descriptor.id)) throw new Error("Provider ID must be a lowercase safe identifier.");
  if (!PROVIDER_LABEL.test(descriptor.label)) throw new Error("Provider label must be a safe printable string.");
  if (!isCatalogueModelId(descriptor.defaultModel)) throw new Error("Provider default model must be a bounded safe exact model ID.");
  if (!["api-key", "oauth", "none"].includes(descriptor.credentialRequirement)) throw new Error("Provider credential requirement is invalid.");
  if (Reflect.ownKeys(descriptor.capabilities).some((key) => typeof key !== "string" || !PROVIDER_CAPABILITY_KEYS.has(key))) {
    throw new Error("Provider capabilities contain unexpected properties.");
  }
  for (const capability of ["streaming", "toolCalls", "toolResultContinuation", "usageMetadata"] as const) {
    if (typeof descriptor.capabilities[capability] !== "boolean") throw new Error("Provider capabilities must be explicit booleans.");
  }
  if (descriptor.modelCatalogue !== undefined) validateModelCatalogue(descriptor.modelCatalogue);
  if (descriptor.reasoningModels) {
    if (Object.keys(descriptor.reasoningModels).length > 128) throw new Error("Too many reasoning models.");
    for (const [model, levels] of Object.entries(descriptor.reasoningModels)) {
      if (!Array.isArray(levels) || !levels.length || new Set(levels).size !== levels.length) throw new Error("Invalid reasoning levels.");
      for (const level of levels) parseReasoningPreferences({ [descriptor.id]: { [model]: level } }, [descriptor.id]);
    }
  }
  if (typeof descriptor.createModel !== "function") throw new Error("Provider must define a model factory.");
}

function copyDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  return Object.freeze({
    id: descriptor.id,
    label: descriptor.label,
    defaultModel: descriptor.defaultModel,
    credentialRequirement: descriptor.credentialRequirement,
    capabilities: Object.freeze({
      streaming: descriptor.capabilities.streaming,
      toolCalls: descriptor.capabilities.toolCalls,
      toolResultContinuation: descriptor.capabilities.toolResultContinuation,
      usageMetadata: descriptor.capabilities.usageMetadata,
    }),
    ...(descriptor.reasoningModels ? { reasoningModels: Object.freeze(Object.fromEntries(Object.entries(descriptor.reasoningModels).map(([model, levels]) => [model, Object.freeze([...levels])])) ) } : {}),
    ...(descriptor.modelCatalogue === undefined ? {} : { modelCatalogue: Object.freeze([...descriptor.modelCatalogue]) }),
    createModel: descriptor.createModel,
  });
}

/**
 * Bounded provider registration boundary. It contains metadata and per-run factories only:
 * credentials, sessions, continuation state, and request wire formats stay outside it.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ProviderDescriptor>();
  private reasoningPreferences: ReasoningPreferences = {};
  private persistReasoning?: (preferences: ReasoningPreferences) => Promise<void>;
  private fallback: ProviderFallbackConfiguration = { enabled: false, targets: [] };

  /** Process-local explicit opt-in; never guesses model IDs or creates adapters here. */
  configureFallback(configuration: ProviderFallbackConfiguration = { enabled: false, targets: [] }): void {
    if (!configuration || Reflect.ownKeys(configuration).some((key) => key !== "enabled" && key !== "targets")
      || typeof configuration.enabled !== "boolean" || !Array.isArray(configuration.targets)
      || configuration.targets.length > 3 || (configuration.enabled && !configuration.targets.length)) {
      throw new Error("Fallback requires an explicit enabled flag and at most three exact targets.");
    }
    const seen = new Set<string>();
    const targets = configuration.targets.map((target) => {
      if (!target || Reflect.ownKeys(target).some((key) => key !== "provider" && key !== "model")
        || typeof target.provider !== "string" || !isCatalogueModelId(target.model)) throw new Error("Invalid fallback target.");
      const provider = this.get(target.provider);
      if (target.model !== provider.defaultModel && !provider.modelCatalogue?.includes(target.model)) {
        throw new Error("Fallback model must be an exact registered catalogue or default model.");
      }
      const key = JSON.stringify([target.provider, target.model]);
      if (seen.has(key)) throw new Error("Duplicate fallback target.");
      seen.add(key);
      return Object.freeze({ provider: target.provider, model: target.model });
    });
    this.fallback = Object.freeze({ enabled: configuration.enabled, targets: Object.freeze(targets) });
  }

  configureReasoning(preferences: ReasoningPreferences = {}, persist?: (preferences: ReasoningPreferences) => Promise<void>): void {
    const parsed = parseReasoningPreferences(preferences, this.ids());
    for (const [id, models] of Object.entries(parsed)) for (const [model, level] of Object.entries(models)) validateReasoning(this.get(id).reasoningModels, model, level);
    this.reasoningPreferences = parsed;
    this.persistReasoning = persist;
  }

  async reasoning(id: string, model: string, selection?: string): Promise<string> {
    const levels = reasoningLevels(this.get(id).reasoningModels, model);
    if (!levels.length) return "Reasoning is unsupported or unverified for this provider/model; no effort is sent.";
    if (selection !== undefined) {
      if (selection !== "default") validateReasoning(this.get(id).reasoningModels, model, selection);
      const next = structuredClone(this.reasoningPreferences);
      next[id] ??= {};
      if (selection === "default") delete next[id]![model];
      else next[id]![model] = selection as ReasoningLevel;
      await this.persistReasoning?.(structuredClone(next));
      this.reasoningPreferences = next;
    }
    return `Reasoning: ${this.reasoningPreferences[id]?.[model] ?? "default (provider decides)"}. Available: default, ${levels.join(", ")}. Applies to the next run${this.persistReasoning ? "; saved in this profile" : " (not persisted)"}.`;
  }

  register(descriptor: ProviderDescriptor): void {
    validateDescriptor(descriptor);
    if (this.providers.has(descriptor.id)) throw new Error(`Provider is already registered: ${descriptor.id}`);
    this.providers.set(descriptor.id, copyDescriptor(descriptor));
  }

  get(id: ProviderId): ProviderDescriptor {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}.`);
    return provider;
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  ids(): ProviderId[] {
    return [...this.providers.keys()];
  }

  list(): ProviderDescriptor[] {
    return [...this.providers.values()];
  }

  createModel(id: ProviderId, context: ProviderModelFactoryContext = {}, adoptFallbackIdentity?: AdoptFallbackIdentity): AgentModel {
    const create = (providerId: string, factoryContext: ProviderModelFactoryContext): AgentModel => {
      const provider = this.get(providerId);
      const model = factoryContext.model ?? provider.defaultModel;
      const reasoning = factoryContext.reasoning ?? this.reasoningPreferences[providerId]?.[model];
      if (reasoning !== undefined) validateReasoning(provider.reasoningModels, model, reasoning);
      return provider.createModel({ ...factoryContext, ...(reasoning === undefined ? {} : { reasoning }) });
    };
    let outputStarted = false;
    const write = context.write === undefined ? undefined : (text: string) => { outputStarted = true; context.write!(text); };
    const primary = create(id, this.fallback.enabled && write ? { ...context, write } : context);
    if (!this.fallback.enabled) return primary;
    const model = context.model ?? this.get(id).defaultModel;
    const targets = this.fallback.targets.filter((target) => target.provider !== id || target.model !== model);
    return createFallbackModel(primary, targets, (target) => create(target.provider, {
      model: target.model,
      // Reasoning preferences belong to the target, never the original model.
      ...(write === undefined ? {} : { write }),
    }), adoptFallbackIdentity, () => outputStarted);
  }
}

export function createProviderRegistry(descriptors: readonly ProviderDescriptor[] = []): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const descriptor of descriptors) registry.register(descriptor);
  return registry;
}
