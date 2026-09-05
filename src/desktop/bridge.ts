import type {
  DragonsRuntime,
  RuntimeEvent,
  RuntimeRunHandle,
} from "../runtime.js";

export const MAX_DESKTOP_CONTENT_CHARACTERS = 64_000;
export const MAX_DESKTOP_MESSAGE_BYTES = 256_000;

/** Decoded JSON only; unknown keys, nested values and session-wide approval are rejected. */
export type DesktopCommand =
  | { type: "providers" }
  | { type: "create"; provider?: string; model?: string }
  | { type: "resume"; sessionId: string }
  | { type: "status" }
  | { type: "send"; content: string; sessionId?: string }
  | { type: "approve"; sessionId: string; runId: string; approvalId: string; decision: "allow_once" | "deny" }
  | { type: "cancel"; runId: string };

export type DesktopBridgeErrorCode =
  | "INVALID_MESSAGE" | "CLOSED" | "BUSY" | "NO_SESSION"
  | "STALE_SESSION" | "NOT_OWNED" | "NOT_PENDING" | "RUNTIME_ERROR";

export type DesktopBridgeReply<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code: DesktopBridgeErrorCode; message: string } };

/** send returns admission metadata; its result arrives only as an owned terminal RuntimeEvent. */
export type DesktopRunAdmission = { runId: string; sessionId: string };

const messages: Record<DesktopBridgeErrorCode, string> = {
  INVALID_MESSAGE: "Invalid desktop command.",
  CLOSED: "Desktop bridge is closed.",
  BUSY: "Desktop bridge is busy.",
  NO_SESSION: "Attach a desktop session first.",
  STALE_SESSION: "Desktop session is no longer attached.",
  NOT_OWNED: "Run is not active in this desktop bridge.",
  NOT_PENDING: "Approval is not pending in this desktop bridge.",
  RUNTIME_ERROR: "Desktop runtime request failed.",
};

function failure(code: DesktopBridgeErrorCode): DesktopBridgeReply<never> {
  return { ok: false, error: { code, message: messages[code] } };
}

function success<T>(value: T): DesktopBridgeReply<T> {
  return { ok: true, value };
}

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const providerPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

function commandFrom(input: unknown): DesktopCommand | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return;
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return;
  const keys = Reflect.ownKeys(input);
  if (keys.length === 0 || keys.length > 6) return;
  // Copy data properties, never invoke getters or toJSON on an untrusted IPC value.
  const copy: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    if (typeof key !== "string") return;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") return;
    if (descriptor.value.length > MAX_DESKTOP_CONTENT_CHARACTERS) return;
    copy[key] = descriptor.value;
  }
  const exact = (required: string[], optional: string[] = []): boolean =>
    required.every((key) => Object.hasOwn(copy, key)) && keys.every((key) => typeof key === "string" && (required.includes(key) || optional.includes(key)));
  const sessionId = (): boolean => sessionIdPattern.test(copy.sessionId ?? "");
  let valid = false;
  switch (copy.type) {
    case "providers":
    case "status":
      valid = exact(["type"]);
      break;
    case "create":
      valid = exact(["type"], ["provider", "model"])
        && (copy.provider === undefined || providerPattern.test(copy.provider))
        && (copy.model === undefined || (copy.model.length > 0 && copy.model.length <= 256
          && copy.model === copy.model.trim() && !/[\u0000-\u001f\u007f]/.test(copy.model)));
      break;
    case "resume":
      valid = exact(["type", "sessionId"]) && sessionId();
      break;
    case "send":
      valid = exact(["type", "content"], ["sessionId"]) && !!copy.content?.trim()
        && (copy.sessionId === undefined || sessionId());
      break;
    case "approve":
      valid = exact(["type", "sessionId", "runId", "approvalId", "decision"])
        && sessionId() && identifierPattern.test(copy.runId ?? "") && identifierPattern.test(copy.approvalId ?? "")
        && (copy.decision === "allow_once" || copy.decision === "deny");
      break;
    case "cancel":
      valid = exact(["type", "runId"]) && identifierPattern.test(copy.runId ?? "");
      break;
  }
  if (!valid || Buffer.byteLength(JSON.stringify(copy), "utf8") > MAX_DESKTOP_MESSAGE_BYTES) return;
  return copy as DesktopCommand;
}

type OwnedRun = {
  handle: RuntimeRunHandle;
  settled: Promise<void>;
  approvals: Set<string>;
  cancelled: boolean;
};

/**
 * One trusted-main-process runtime per bridge. The host authenticates the IPC sender;
 * never expose this instance or runtime to the renderer. No fs/shell/config commands.
 *
 * providers/create/resume/status return public runtime DTOs. approve/cancel return booleans.
 * send optionally checks sessionId for stale renderer state and returns DesktopRunAdmission.
 * Memory suggestions are acknowledged only to reject them, never emitted or accepted.
 * close is idempotent: stop admissions/events synchronously, cancel and dispose the runtime.
 * In-flight store requests may finish later, but cannot reattach a session or publish events.
 */
export class DesktopBridge {
  readonly #runtime: DragonsRuntime;
  readonly #emit: (event: RuntimeEvent) => void;
  #sessionId?: string;
  #active?: OwnedRun;
  #admitting = false;
  #closed = false;
  #closing?: Promise<void>;

  constructor(runtime: DragonsRuntime, emit: (event: RuntimeEvent) => void) {
    this.#runtime = runtime;
    this.#emit = emit;
  }

  async request(input: unknown): Promise<DesktopBridgeReply> {
    if (this.#closed) return failure("CLOSED");
    let command: DesktopCommand | undefined;
    try { command = commandFrom(input); } catch { /* Non-JSON/proxy input also fails closed. */ }
    if (!command) return failure("INVALID_MESSAGE");

    // Controls are synchronous and remain available while status/admission/run work awaits.
    try {
      if (command.type === "providers") return success(this.#runtime.providers());
      if (command.type === "approve") {
        if (command.sessionId !== this.#sessionId) return failure("STALE_SESSION");
        const run = this.#active;
        if (!run || run.handle.id !== command.runId) return failure("NOT_OWNED");
        if (run.cancelled || !run.approvals.delete(command.approvalId)) return failure("NOT_PENDING");
        return this.#runtime.resolveAuthorization({ runId: command.runId, approvalId: command.approvalId, decision: command.decision })
          ? success(true) : failure("NOT_PENDING");
      }
      if (command.type === "cancel") {
        const run = this.#active;
        if (!run || run.handle.id !== command.runId) return failure("NOT_OWNED");
        run.cancelled = true;
        run.approvals.clear();
        return success(this.#runtime.cancelRun(command.runId));
      }
    } catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }

    // Reserve before the first await: concurrent creates, sends and session swaps cannot race.
    if (this.#admitting || (this.#active && command.type !== "status")) return failure("BUSY");
    if (command.type === "send") {
      if (!this.#sessionId) return failure("NO_SESSION");
      if (command.sessionId !== undefined && command.sessionId !== this.#sessionId) return failure("STALE_SESSION");
    }
    this.#admitting = true;
    try {
      if (command.type === "create" || command.type === "resume") {
        const session = command.type === "create"
          ? await this.#runtime.createSession({
            ...(command.provider === undefined ? {} : { provider: command.provider }),
            ...(command.model === undefined ? {} : { model: command.model }),
          })
          : await this.#runtime.resumeSession(command.sessionId);
        if (this.#closed) return failure("CLOSED");
        this.#sessionId = session.id;
        return success(session);
      }
      if (command.type === "status") {
        const status = await this.#runtime.status(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId });
        return this.#closed ? failure("CLOSED") : success(status);
      }
      if (command.type === "send") {
        const sessionId = this.#sessionId!;
        const handle = await this.#runtime.sendUserInput({ sessionId, content: command.content });
        // Observe rejection before any lifecycle check, event iteration, or further await.
        const settled = handle.result.then(() => {}, () => {});
        if (this.#closed || handle.sessionId !== sessionId) {
          handle.cancel();
          return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR");
        }
        const run: OwnedRun = { handle, settled, approvals: new Set(), cancelled: false };
        this.#active = run;
        void this.#consume(run).catch(() => { void this.close(); });
        return success<DesktopRunAdmission>({ runId: handle.id, sessionId });
      }
      return failure("INVALID_MESSAGE");
    } catch {
      return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR");
    } finally {
      this.#admitting = false;
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const run = this.#active;
    this.#active = undefined;
    this.#sessionId = undefined;
    run?.approvals.clear();
    // Defer effects one microtask so reentrant/concurrent close calls share the same promise.
    this.#closing = Promise.resolve().then(async () => {
      try { run?.handle.cancel(); } catch { /* Disposal must still run. */ }
      try { await this.#runtime.dispose(); } catch { /* Never expose private disposal exceptions. */ }
    });
    return this.#closing;
  }

  #owns(run: OwnedRun, event: RuntimeEvent): boolean {
    return !this.#closed && this.#active === run && event.runId === run.handle.id
      && event.sessionId === run.handle.sessionId && event.sessionId === this.#sessionId;
  }

  async #consume(run: OwnedRun): Promise<void> {
    try {
      for await (const event of run.handle.events) {
        if (!this.#owns(run, event)) continue;
        if (event.type === "memory_suggestion") {
          const input = { runId: event.runId, sessionId: event.sessionId, suggestionId: event.suggestionId };
          if (!this.#runtime.acknowledgeMemorySuggestion(input)
            || !await this.#runtime.resolveMemorySuggestion({ ...input, decision: "reject" })) {
            run.handle.cancel();
          }
          continue;
        }
        if (event.type === "approval_requested") {
          if (run.cancelled) continue;
          // Defensive cap in addition to the runtime's bounded queue; never retain history.
          if (run.approvals.size >= 256) { run.handle.cancel(); continue; }
          run.approvals.add(event.approvalId);
        }
        if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled") {
          // Runtime terminal events precede its finally cleanup. Wait for that cleanup so an
          // emit callback can immediately send again, then release ownership BEFORE emitting.
          await run.settled;
          if (!this.#owns(run, event)) continue;
          run.approvals.clear();
          this.#active = undefined;
          this.#emit(event.type === "run_failed" ? { ...event, message: "Desktop run failed." } : event);
          return;
        }
        this.#emit(event);
      }
    } finally {
      if (this.#active === run) {
        run.approvals.clear();
        run.handle.cancel();
        await run.settled;
        if (this.#active === run) this.#active = undefined;
      }
    }
  }
}
