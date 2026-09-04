export type ProviderCompatibilityKind =
  | "authentication"
  | "entitlement"
  | "model_unavailable"
  | "rate_limit"
  | "transient"
  | "malformed_response"
  | "protocol_drift"
  | "first_party_identity"
  | "cancelled"
  | "invalid_request";

export type ProviderDiagnosticKind = Exclude<ProviderCompatibilityKind, "cancelled" | "invalid_request">;

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI Platform",
  chatgpt: "ChatGPT Subscription",
  anthropic: "Anthropic",
};

export class ProviderCompatibilityError extends Error {
  readonly compatibilityKind: ProviderCompatibilityKind;
  readonly status?: number;

  constructor(provider: string, kind: ProviderCompatibilityKind, status?: number) {
    super(providerCompatibilityMessage(provider, kind, status));
    this.name = "ProviderCompatibilityError";
    this.compatibilityKind = kind;
    this.status = status;
  }
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? "Provider";
}

export function providerCompatibilityMessage(provider: string, kind: ProviderCompatibilityKind, status?: number): string {
  const label = providerLabel(provider);
  const suffix = status === undefined ? "" : ` (HTTP ${status})`;
  if (kind === "authentication") return provider === "chatgpt"
    ? `${label} authentication failed. Run dragons auth login --provider chatgpt or verify the configured API key.${suffix}`
    : `${label} authentication failed. Verify the configured API key.${suffix}`;
  if (kind === "entitlement") return `${label} account or workspace is not entitled to this request. Review the selected account and model.${suffix}`;
  if (kind === "model_unavailable") return `${label} model is unavailable or not entitled. Select a supported configured model and try again.${suffix}`;
  if (kind === "rate_limit") return `${label} rate limit reached. Wait before retrying.${suffix}`;
  if (kind === "transient") return `${label} service is temporarily unavailable. Try again later.${suffix}`;
  if (kind === "malformed_response") return `${label} returned a malformed response. No tool was executed.`;
  if (kind === "protocol_drift") return `${label} response is incompatible with this Dragons adapter. No tool was executed.`;
  if (kind === "first_party_identity") return `${label} requires a first-party client identity that Dragons will not impersonate.${suffix}`;
  if (kind === "cancelled") return `${label} request was cancelled.`;
  return `${label} rejected the request. Review the request and configured model.${suffix}`;
}

export function providerCompatibilityError(provider: string, kind: ProviderCompatibilityKind, status?: number): ProviderCompatibilityError {
  return new ProviderCompatibilityError(provider, kind, status);
}

/** Inspect short provider error metadata locally but never surface its contents. */
export function classifyProviderHttpFailure(status: number, body = ""): ProviderCompatibilityKind {
  const normalized = body.toLowerCase();
  if (status === 401) return "authentication";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 409 || status === 425 || status >= 500) return "transient";
  if (status === 403 && /(model|entitl|workspace|account|plan|subscription)/.test(normalized)) return "entitlement";
  if (status === 404 || ((status === 400 || status === 403) && /(model|unsupported_model|not.?found|unavailable)/.test(normalized))) return "model_unavailable";
  if (status === 403) return "authentication";
  return "invalid_request";
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}
