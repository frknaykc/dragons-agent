import type { AgentModel } from "../agent.js";

export type ProviderId = string;
export const DEFAULT_PROVIDER_IDS = ["openai-api", "chatgpt", "anthropic", "gemini", "openrouter"] as const;

export type ProviderCredentialRequirement = "api-key" | "oauth" | "none";

export type ProviderCapabilities = Readonly<{
  streaming: boolean;
  toolCalls: boolean;
  toolResultContinuation: boolean;
  usageMetadata: boolean;
}>;

export type ProviderModelFactoryContext = Readonly<{
  model?: string;
  /** CLI-only output capability; never persisted or forwarded to a provider request. */
  write?: (text: string) => void;
}>;

export type ProviderDescriptor = Readonly<{
  id: ProviderId;
  label: string;
  defaultModel: string;
  credentialRequirement: ProviderCredentialRequirement;
  capabilities: ProviderCapabilities;
  /** Creates isolated model state for one Dragons run, session, child, or background job. */
  createModel: (context: ProviderModelFactoryContext) => AgentModel;
}>;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PROVIDER_LABEL = /^[\x20-\x7e]{1,128}$/;
const PROVIDER_DESCRIPTOR_KEYS = new Set(["id", "label", "defaultModel", "credentialRequirement", "capabilities", "createModel"]);
const PROVIDER_CAPABILITY_KEYS = new Set(["streaming", "toolCalls", "toolResultContinuation", "usageMetadata"]);

function validateDescriptor(descriptor: ProviderDescriptor): void {
  if (Reflect.ownKeys(descriptor).some((key) => typeof key !== "string" || !PROVIDER_DESCRIPTOR_KEYS.has(key))) {
    throw new Error("Provider descriptor contains unexpected properties.");
  }
  if (!PROVIDER_ID.test(descriptor.id)) throw new Error("Provider ID must be a lowercase safe identifier.");
  if (!PROVIDER_LABEL.test(descriptor.label)) throw new Error("Provider label must be a safe printable string.");
  if (!descriptor.defaultModel.trim() || descriptor.defaultModel.length > 256) throw new Error("Provider default model must be a bounded non-empty string.");
  if (!["api-key", "oauth", "none"].includes(descriptor.credentialRequirement)) throw new Error("Provider credential requirement is invalid.");
  if (Reflect.ownKeys(descriptor.capabilities).some((key) => typeof key !== "string" || !PROVIDER_CAPABILITY_KEYS.has(key))) {
    throw new Error("Provider capabilities contain unexpected properties.");
  }
  for (const capability of ["streaming", "toolCalls", "toolResultContinuation", "usageMetadata"] as const) {
    if (typeof descriptor.capabilities[capability] !== "boolean") throw new Error("Provider capabilities must be explicit booleans.");
  }
  if (typeof descriptor.createModel !== "function") throw new Error("Provider must define a model factory.");
}

function copyDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  return Object.freeze({
    id: descriptor.id,
    label: descriptor.label,
    defaultModel: descriptor.defaultModel.trim(),
    credentialRequirement: descriptor.credentialRequirement,
    capabilities: Object.freeze({
      streaming: descriptor.capabilities.streaming,
      toolCalls: descriptor.capabilities.toolCalls,
      toolResultContinuation: descriptor.capabilities.toolResultContinuation,
      usageMetadata: descriptor.capabilities.usageMetadata,
    }),
    createModel: descriptor.createModel,
  });
}

/**
 * Bounded provider registration boundary. It contains metadata and per-run factories only:
 * credentials, sessions, continuation state, and request wire formats stay outside it.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ProviderDescriptor>();

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

  createModel(id: ProviderId, context: ProviderModelFactoryContext = {}): AgentModel {
    return this.get(id).createModel({ ...context });
  }
}

export function createProviderRegistry(descriptors: readonly ProviderDescriptor[] = []): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const descriptor of descriptors) registry.register(descriptor);
  return registry;
}
