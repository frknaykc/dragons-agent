import {
  classifyProviderHttpFailure,
  isAbortError,
  ProviderCompatibilityError,
  type ProviderCompatibilityKind,
} from "./provider/compatibility.js";

export type RetryOptions = {
  maxAttempts?: number;
  delayMilliseconds?: number;
  signal?: AbortSignal;
  /** Invoked only before the next attempt; never receives raw request or error content. */
  onRetry?: () => void;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAY_MILLISECONDS = 250;

export type ProviderErrorKind = ProviderCompatibilityKind;

export function classifyProviderError(error: unknown): ProviderErrorKind {
  if (isAbortError(error)) return "cancelled";
  if (error instanceof ProviderCompatibilityError) return error.compatibilityKind;
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return classifyProviderHttpFailure(status);
  }
  if (error instanceof TypeError || (error instanceof Error && /network|timeout|temporar/i.test(error.message))) return "transient";
  return "invalid_request";
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = (): void => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
    function cleanup(): void { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    function done(): void { cleanup(); resolve(); }
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function retryProviderRequest<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMilliseconds = options.delayMilliseconds ?? DEFAULT_DELAY_MILLISECONDS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("Retry maxAttempts must be a positive integer.");
  if (!Number.isSafeInteger(delayMilliseconds) || delayMilliseconds < 0) throw new Error("Retry delayMilliseconds must be a non-negative integer.");
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try { return await operation(); } catch (error: unknown) {
      lastError = error;
      const kind = classifyProviderError(error);
      if ((kind !== "transient" && kind !== "rate_limit") || attempt === maxAttempts) throw error;
      options.onRetry?.();
      await wait(delayMilliseconds * (2 ** (attempt - 1)), options.signal);
    }
  }
  throw lastError;
}
