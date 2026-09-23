import { reasoningLevels, type ReasoningModels } from "./provider/reasoning.js";
import { modelCatalogueChoices, type ModelCatalogue } from "./provider/model-catalogue.js";
import { SLASH_COMMANDS } from "./slash-commands.js";

export type SlashChoice = Readonly<{ value: string; description: string }>;
export type ChoiceProvider = Readonly<{
  id: string;
  label: string;
  defaultModel: string;
  modelCatalogue?: ModelCatalogue;
  reasoningModels?: ReasoningModels;
  credentialRequirement: "oauth" | "api-key" | "none";
  capabilities?: Readonly<{ streaming: boolean; toolCalls: boolean; toolResultContinuation: boolean; usageMetadata: boolean }>;
}>;

/** Public provider metadata only: this intentionally has no credential, endpoint, factory, or entitlement state. */
export function formatProviderList(providers: readonly ChoiceProvider[], currentProvider?: string): string {
  const current = currentProvider ?? "none";
  if (!providers.length) return `Provider: ${current}\nNo providers are registered.`;
  const entries = providers.slice(0, 32).map((provider) => {
    const catalogue = provider.modelCatalogue?.length ?? 0;
    const reasoning = provider.reasoningModels && Object.keys(provider.reasoningModels).length > 0 ? "verified reasoning metadata" : "no verified reasoning metadata";
    const capabilities = provider.capabilities
      ? [provider.capabilities.streaming ? "streaming" : undefined, provider.capabilities.toolCalls ? "tool calls" : undefined,
        provider.capabilities.toolResultContinuation ? "tool continuation" : undefined, provider.capabilities.usageMetadata ? "usage metadata" : undefined].filter(Boolean).join(", ") || "none"
      : "not declared";
    return `${provider.id}: ${provider.label}; credentials ${provider.credentialRequirement}; default ${provider.defaultModel}; ${catalogue} curated model${catalogue === 1 ? "" : "s"}; ${reasoning}; capabilities ${capabilities}; access not verified`;
  });
  return `Provider: ${current}\nAvailable:\n${entries.join("\n")}`;
}

export const LOGIN_PROVIDERS: readonly ChoiceProvider[] = [
  { id: "chatgpt", label: "ChatGPT Subscription", defaultModel: "", credentialRequirement: "oauth" },
  ...["openai-api", "anthropic", "gemini", "openrouter"].map((id) => ({ id, label: id, defaultModel: "", credentialRequirement: "api-key" as const })),
  { id: "local", label: "Local", defaultModel: "", credentialRequirement: "none" },
];
const KEY_ENV: Readonly<Record<string, string>> = { "openai-api": "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
/** No credential is accepted by a slash command. Only the existing ChatGPT adapter supports OAuth. */
export function loginSetup(provider?: string): string | undefined {
  if (provider === "chatgpt") return undefined;
  if (provider && KEY_ENV[provider]) return `Use the local full-screen TUI (dragons --tui), then /login ${provider}, for dedicated masked API-key entry into profile OS storage. This UI has no key entry; alternatively set ${KEY_ENV[provider]} securely before starting Dragons. Never paste keys into chat or slash commands. This provider does not use ChatGPT OAuth.`;
  if (provider === "local") return "Local models require no login. Configure the supported loopback endpoint and select /provider local.";
  return `Choose a provider: ${LOGIN_PROVIDERS.map((p) => `/login ${p.id}`).join(", ")}`;
}

/** Pure, bounded completion metadata. Catalogues and configured/default IDs are NOT account entitlement. */
export function slashChoices(input: string, available: readonly string[], providers: readonly ChoiceProvider[] = [], providerId?: string, model?: string): SlashChoice[] {
  if (input.length > 8000 || !input.startsWith("/")) return [];
  const space = input.indexOf(" ");
  if (space < 0) return SLASH_COMMANDS.filter((c) => available.includes(c.name) && c.name.startsWith(input)).slice(0, 32).map((c) => ({ value: c.name, description: c.description }));
  const command = input.slice(0, space);
  if (!available.includes(command)) return [];
  const prefix = input.slice(space + 1).trimStart();
  // A completed argument followed by whitespace must be submittable, not trapped by completion.
  if (prefix.trim() && /\s$/.test(prefix) && !(command === "/auth" && prefix === "status ")) return [];
  let choices: SlashChoice[] = [];
  if (command === "/login") choices = LOGIN_PROVIDERS.map((p) => ({ value: p.id, description: p.credentialRequirement === "oauth" ? "Device sign-in · profile secure store" : p.credentialRequirement === "none" ? "No credentials required" : "Masked entry in local TUI · OS secure store" }));
  if (command === "/provider") choices = providers.slice(0, 32).map((p) => ({ value: p.id, description: p.label }));
  if (command === "/auth" || command === "/logout") choices = LOGIN_PROVIDERS.map((p) => ({ value: p.id, description: p.label }));
  if (command === "/auth" && prefix.startsWith("status ")) choices = LOGIN_PROVIDERS.map((p) => ({ value: `status ${p.id}`, description: p.label }));
  if (command === "/model") { const p = providers.find((p) => p.id === providerId); if (p) choices = modelCatalogueChoices(p, model); }
  if (command === "/reasoning") {
    const p = providers.find((p) => p.id === providerId);
    const levels = model ? reasoningLevels(p?.reasoningModels, model) : [];
    if (levels.length) choices = ["default", ...levels].map((value) => ({ value, description: value === "default" ? "Omit effort; provider decides" : "Verified model effort; applies to next run" }));
  }
  if (command === "/profile") choices = ["list", "create", "select"].map((value) => ({ value, description: value === "list" ? "List profiles" : "Requires a profile name" }));

  return choices.filter((c) => c.value.startsWith(prefix) && /^[\x20-\x7e]{1,256}$/.test(c.value)).slice(0, 32).map((c) => ({ value: `${command} ${c.value}`, description: c.description.slice(0, 256) }));
}

/** Selecting only completes text. A separate explicit submit executes the local command. */
export class SlashPicker {
  selected = 0;
  dismissed = false;
  reset(): void { this.selected = 0; this.dismissed = false; }
  key(key: string, choices: readonly SlashChoice[]): string | undefined {
    if (key === "cancel") { this.dismissed = true; return undefined; }
    if (this.dismissed || !choices.length) return undefined;
    if (key === "up") this.selected = (this.selected + choices.length - 1) % choices.length;
    if (key === "down") this.selected = (this.selected + 1) % choices.length;
    if (key === "enter" || key === "tab") return choices[this.selected % choices.length]!.value + " ";
    return undefined;
  }
}
