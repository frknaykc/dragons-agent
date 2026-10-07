import { INLINE_URL_TOOL, validateContextUrl } from "../inline-context-url.js";
import { validateLspApproval } from "../lsp-approval.js";
import type {
  DragonsRuntime,
  RuntimeEvent,
  RuntimeRunHandle,
} from "../runtime.js";
import { DesktopUpdateController } from "./update-controller.js";
import { RuntimeTextRedactor } from "../runtime-redaction.js";
import { isCheckpointCommand } from "../checkpoint.js";
import { formatSlashHelp } from "../slash-commands.js";
import { formatProviderList, loginSetup, slashChoices } from "../slash-choices.js";
import { isApiKeyProvider, isApiKeySlot, type ApiKeyProvider, type SecretPrompt } from "../provider/api-key-auth.js";
import { isSafeProfileName } from "../profiles.js";
import type { DesktopCronCommand } from "./cron-service.js";
import type { DesktopSessionLoopCommand } from "./session-loop-service.js";
import type { DesktopGoalCommand } from "./persistent-goal-service.js";
import { KANBAN_USAGE, parseInteractiveKanbanCommand, parseKanbanWorkerLane, parseKanbanWorkerStart } from "../cli/kanban-commands.js";
import { MIXTURE_USAGE, parseInteractiveMixtureCommand } from "../cli/mixture-commands.js";
import type { DesktopMixtureCommand } from "./mixture-service.js";
import type { DesktopKanbanCommand } from "./kanban-service.js";
import type { DesktopBatchCommand } from "./batch-service.js";
import { BATCH_USAGE, parseInteractiveBatchCommand } from "../cli/batch-commands.js";
import { observeRuntimeRun } from "../runtime-observation.js";

export const MAX_DESKTOP_CONTENT_CHARACTERS = 64_000;
export const MAX_DESKTOP_MESSAGE_BYTES = 256_000;

/** Decoded JSON only; unknown keys, nested values and session-wide approval are rejected. */
export type DesktopCommand =
  | { type: "choices"; content: string; provider?: string }
  | { type: "kanban_board" }
  | { type: "slash"; content: string }
  | { type: "update_status" | "update_check" | "update_prepare" | "update_cancel" }
  | { type: "providers" }
  | { type: "create"; provider?: string; model?: string }
  | { type: "resume"; sessionId: string }
  | { type: "status" }
  | { type: "background" }
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
    case "choices":
      valid = exact(["type", "content"], ["provider"]) && copy.content!.length <= 8000 && (copy.provider === undefined || providerPattern.test(copy.provider));
      break;
    case "update_status":
    case "update_check":
    case "update_prepare":
    case "update_cancel":
    case "providers":
    case "kanban_board":
    case "status":
    case "background":
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
    case "slash":
      valid = exact(["type", "content"]) && !!copy.content?.trim().startsWith("/");
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
export type DesktopLocalControls = {
  requestSecret?: SecretPrompt;
  loginApiKey?: (provider: ApiKeyProvider, slot?: string) => Promise<boolean>;
  listApiKeySlots?: (provider: ApiKeyProvider) => Promise<string>;
  removeApiKeySlot?: (provider: ApiKeyProvider, slot: string) => Promise<void>;
  reasoning?: (provider: string, model: string, level?: string) => Promise<string>;
  worktree?: (action: "create" | "select", name: string) => Promise<string>;
  cron?: (command: DesktopCronCommand) => Promise<string>;
  goal?: (command: DesktopGoalCommand) => Promise<string>;
  kanban?: (command: DesktopKanbanCommand) => Promise<string>;
  mixture?: (command: DesktopMixtureCommand) => Promise<string>;
  batch?: (command: DesktopBatchCommand) => Promise<string>;
  kanbanBoard?: () => Promise<import("../kanban.js").KanbanTask[]>;
  loop?: (command: DesktopSessionLoopCommand) => Promise<string>;
  loopActivity?: (sessionId: string) => void;
  sessions(): Promise<string>;
  defaultProvider?: string;
  auth(provider?: string): Promise<string>;
  login(): Promise<string>;
  logout(provider?: string): Promise<string>;
  profiles(): Promise<string>;
  createProfile(name: string): Promise<string>;
  selectProfile(name: string): Promise<void>;
  close(): Promise<void>;
};

export class DesktopBridge {
  readonly #runtime: DragonsRuntime;
  readonly #emit: (event: RuntimeEvent) => void;
  #sessionId?: string;
  #active?: OwnedRun;
  #admitting = false;
  #closed = false;
  #closing?: Promise<void>;

  constructor(runtime: DragonsRuntime, emit: (event: RuntimeEvent) => void, private readonly local?: DesktopLocalControls, private readonly updates = new DesktopUpdateController()) {
    this.#runtime = runtime;
    this.#emit = emit;
  }

  async request(input: unknown): Promise<DesktopBridgeReply> {
    if (this.#closed) return failure("CLOSED");
    let command: DesktopCommand | undefined;
    try { command = commandFrom(input); } catch { /* Non-JSON/proxy input also fails closed. */ }
    if (!command) return failure("INVALID_MESSAGE");

    if (command.type === "update_status") return success(this.updates.status());
    if (command.type === "update_prepare") return success(this.updates.prepare());
    if (command.type === "update_check") return success(this.updates.check());
    if (command.type === "update_cancel") return success(this.updates.cancel());

    if (command.type === "kanban_board") {
      if (!this.local?.kanbanBoard) return failure("INVALID_MESSAGE");
      try {
        const tasks = await this.local.kanbanBoard();
        return this.#closed ? failure("CLOSED") : success(tasks);
      } catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
    }

    if (command.type === "choices") {
      try {
        // Model and reasoning choices belong to the attached host session.
        const session = (command.content.startsWith("/reasoning ") || command.content.startsWith("/model ")) && this.#sessionId
          ? (await this.#runtime.status({ sessionId: this.#sessionId })).session : undefined;
        if (this.#closed) return failure("CLOSED");
        return success(slashChoices(command.content, ["/help", "/checkpoint", "/rollback", "/new", "/resume", "/status", "/provider", "/model", ...(this.local?.reasoning ? ["/reasoning"] : []), ...(this.local ? ["/sessions", "/login", "/logout", "/auth", "/profile", "/worktree"] : []), ...(this.local?.cron ? ["/cron"] : []), ...(this.local?.goal ? ["/goal"] : []), ...(this.local?.kanban ? ["/kanban"] : []), ...(this.local?.mixture ? ["/moa"] : []), ...(this.local?.batch ? ["/batch"] : []), ...(this.local?.loop ? ["/loop", "/heartbeat"] : [])], this.#runtime.providers(), session?.provider ?? command.provider, session?.model));
      } catch { return failure("RUNTIME_ERROR"); }
    }
    if (command.type === "slash" && isCheckpointCommand(command.content)) command = { type: "send", content: command.content };
    if (command.type === "slash" || (command.type === "send" && command.content.trimStart().startsWith("/") && !isCheckpointCommand(command.content))) {
      return this.#slash(command.content);
    }

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
    if (this.#admitting || (this.#active && command.type !== "status" && command.type !== "background")) return failure("BUSY");
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
        if (session.id !== this.#sessionId && this.#sessionId) await this.local?.loop?.({ action: "stop", sessionId: this.#sessionId });
        if (this.#closed) return failure("CLOSED");
        this.#sessionId = session.id;
        if (command.type === "resume") {
          const handle = observeRuntimeRun(this.#runtime, session.id);
          if (handle) {
            const run: OwnedRun = { handle, settled: handle.result.then(() => {}, () => {}), approvals: new Set(), cancelled: false };
            this.#active = run;
            void this.#consume(run).catch(() => { void this.close(); });
          }
        }
        return success(session);
      }
      if (command.type === "status") {
        const status = await this.#runtime.status(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId });
        if (!this.#closed && !this.#active && this.#sessionId) {
          const handle = observeRuntimeRun(this.#runtime, this.#sessionId);
          if (handle) {
            const run: OwnedRun = { handle, settled: handle.result.then(() => {}, () => {}), approvals: new Set(), cancelled: false };
            this.#active = run;
            void this.#consume(run).catch(() => { void this.close(); });
          }
        }
        return this.#closed ? failure("CLOSED") : success(status);
      }
      if (command.type === "background") {
        if (!this.#sessionId) return failure("NO_SESSION");
        const tasks = await this.#runtime.listBackgroundTasks(this.#sessionId);
        return this.#closed ? failure("CLOSED") : success(tasks);
      }
      if (command.type === "send") {
        const sessionId = this.#sessionId!;
        this.local?.loopActivity?.(sessionId);
        // Input is admitted only against the revision acknowledged by this client's facade.
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

  async #slash(content: string): Promise<DesktopBridgeReply> {
    const [name, ...args] = content.trim().split(/\s+/);
    const text = (value: string) => {
      const redactor = new RuntimeTextRedactor();
      return success({ kind: "text", text: (redactor.push(value) + redactor.finish()).slice(0, 32000) });
    };
    const supported = ["/help", "/checkpoint", "/rollback", "/new", "/resume", "/status", "/provider", "/model", ...(this.local?.reasoning ? ["/reasoning"] : []), ...(this.local ? ["/sessions", "/login", "/logout", "/auth", "/profile", "/worktree"] : []), ...(this.local?.cron ? ["/cron"] : []), ...(this.local?.goal ? ["/goal"] : []), ...(this.local?.kanban ? ["/kanban"] : []), ...(this.local?.mixture ? ["/moa"] : []), ...(this.local?.batch ? ["/batch"] : []), ...(this.local?.loop ? ["/loop", "/heartbeat"] : [])];
    if (name === "/help") return text(formatSlashHelp(args.join(" "), supported));
    if (name === "/batch" && this.local?.batch) {
      if (!this.#sessionId) return failure("NO_SESSION");
      const sessionId = this.#sessionId;
      const input = content.trim();
      const command = input === "/batch confirm RUN" ? { action: "confirm" as const }
        : input === "/batch confirm RECOVER" ? { action: "recover_confirm" as const }
        : input === "/batch lock status" ? { action: "lock_status" as const }
        : input === "/batch lock recover" ? { action: "lock_recover" as const }
        : input === "/batch lock confirm RECOVER" ? { action: "lock_confirm" as const }
        : (() => { const request = parseInteractiveBatchCommand(input); return request ? { action: "request" as const, request } : undefined; })();
      if (!command) return text(`${BATCH_USAGE} Confirm with /batch confirm RUN or /batch confirm RECOVER. Lock: /batch lock status | recover | confirm RECOVER.`);
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try {
        const status = await this.#runtime.status({ sessionId });
        if (this.#closed || this.#sessionId !== sessionId) return failure(this.#closed ? "CLOSED" : "STALE_SESSION");
        if (!status.session) return failure("NO_SESSION");
        const result = await this.local.batch({ ...command, sessionId, provider: status.session.provider, model: status.session.model });
        return this.#closed || this.#sessionId !== sessionId ? failure(this.#closed ? "CLOSED" : "STALE_SESSION") : text(result);
      } catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (name === "/moa" && this.local?.mixture) {
      if (!this.#sessionId) return failure("NO_SESSION");
      const sessionId = this.#sessionId;
      const command: DesktopMixtureCommand | undefined = content.trim() === "/moa confirm SHARE"
        ? { action: "confirm", sessionId }
        : (() => { const request = parseInteractiveMixtureCommand(content.trim(), this.#runtime.providers().map(({ id }) => id));
          return request ? { action: "prepare", sessionId, request } : undefined; })();
      if (!command) return text(MIXTURE_USAGE);
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try {
        const result = await this.local.mixture(command);
        return this.#closed || this.#sessionId !== sessionId ? failure(this.#closed ? "CLOSED" : "STALE_SESSION") : text(result);
      } catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (name === "/kanban" && this.local?.kanban) {
      const input = content.trim();
      const lock = input === "/kanban lock status" ? { action: "lock_status" } as const
        : input === "/kanban lock recover" ? { action: "lock_recover" } as const
        : input === "/kanban lock confirm RECOVER" ? { action: "lock_confirm" } as const
        : input === "/kanban lane lock status" ? { action: "lane_lock_status" } as const
        : input === "/kanban lane lock recover" ? { action: "lane_lock_recover" } as const
        : input === "/kanban lane lock confirm RECOVER" ? { action: "lane_lock_confirm" } as const
        : input === "/kanban worker confirm RECOVER" ? { action: "worker_confirm" } as const : undefined;
      const start = parseKanbanWorkerStart(input);
      const lane = parseKanbanWorkerLane(input);
      const command: DesktopKanbanCommand | undefined = lock ?? (start ? { action: "worker_start", ...start }
        : lane ? { action: "worker_lane", tasks: lane } : parseInteractiveKanbanCommand(input));
      if (!command) return text(input.startsWith("/kanban lane lock")
        ? "Usage: /kanban lane lock status | /kanban lane lock recover | /kanban lane lock confirm RECOVER."
        : input.startsWith("/kanban lock")
        ? "Usage: /kanban lock status | /kanban lock recover | /kanban lock confirm RECOVER."
        : input.startsWith("/kanban worker") ? "Usage: /kanban worker start <id> <revision> | lane <id>:<revision> [<id>:<revision> ...] (up to 8) | recover <id> <revision> <pid> | confirm RECOVER." : KANBAN_USAGE);
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try {
        const result = await this.local.kanban(command);
        return this.#closed ? failure("CLOSED") : text(result);
      } catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (name === "/goal" && this.local?.goal) {
      if (!this.#sessionId) return failure("NO_SESSION");
      const sessionId = this.#sessionId;
      const usage = "Usage: /goal list | status|run|pause|resume|complete|interrupt <id> | add <max-turns> <UTC ISO deadline> -- <objective> -- <completion criterion>.";
      const action = args[0] ?? "list";
      let goalCommand: DesktopGoalCommand;
      if (action === "list" && args.length <= 1) goalCommand = { action, sessionId };
      else if (["status", "run", "pause", "resume", "complete", "interrupt"].includes(action) && args.length === 2 && sessionIdPattern.test(args[1]!))
        goalCommand = { action: action as "status" | "run" | "pause" | "resume" | "complete" | "interrupt", sessionId, id: args[1]! };
      else if (action === "add") {
        const first = content.indexOf(" -- ");
        const second = first < 0 ? -1 : content.indexOf(" -- ", first + 4);
        const fields = first < 0 ? [] : content.slice(0, first).trim().split(/\s+/);
        const objective = second < 0 ? "" : content.slice(first + 4, second).trim();
        const criterion = second < 0 ? "" : content.slice(second + 4).trim();
        if (fields.length !== 4 || !/^[1-9][0-9]{0,1}$/.test(fields[2]!) || !objective || !criterion
          || objective.length > 4_000 || criterion.length > 1_000
          || /[\u0000-\u001f\u007f]/.test(objective + criterion)) return text(usage);
        goalCommand = { action, sessionId, maxTurns: Number(fields[2]), deadlineAt: fields[3]!, objective, criterion };
      } else return text(usage);
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try {
        if (goalCommand.action === "run" && this.local.loop) await this.local.loop({ action: "stop", sessionId });
        const output = await this.local.goal(goalCommand);
        return this.#closed || this.#sessionId !== sessionId ? failure(this.#closed ? "CLOSED" : "STALE_SESSION") : text(output);
      } catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if ((name === "/loop" || name === "/heartbeat") && this.local?.loop) {
      if (!this.#sessionId) return failure("NO_SESSION");
      const usage = name === "/loop" ? "Usage: /loop [status|stop|start <interval-seconds> <max-runs> -- <prompt>]."
        : "Usage: /heartbeat [status|stop|start <interval-seconds> <idle-seconds> <max-runs> -- <prompt>].";
      const action = args[0] ?? "status";
      let loopCommand: DesktopSessionLoopCommand;
      if ((action === "status" || action === "stop") && args.length <= 1) loopCommand = { action, sessionId: this.#sessionId };
      else if (action === "start") {
        const marker = content.indexOf(" -- ");
        if (marker === -1) return text(usage);
        const fields = content.slice(0, marker).trim().split(/\s+/).slice(2);
        const prompt = content.slice(marker + 4).trim();
        if (fields.length !== (name === "/loop" ? 2 : 3) || fields.some((field) => !/^[1-9][0-9]{0,5}$/.test(field))
          || !prompt || prompt.length > 4_000 || /[\u0000-\u001f\u007f]/.test(prompt)) return text(usage);
        const values = fields.map(Number);
        loopCommand = { action: "start", sessionId: this.#sessionId, prompt,
          intervalMs: values[0]! * 1_000, maxRuns: values[name === "/loop" ? 1 : 2]!,
          ...(name === "/heartbeat" ? { idleMs: values[1]! * 1_000 } : {}) };
      } else return text(usage);
      if (this.#admitting || (this.#active && action === "start")) return failure("BUSY");
      this.#admitting = true;
      try { const result = await this.local.loop(loopCommand); return this.#closed ? failure("CLOSED") : text(result); }
      catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (name === "/cron" && this.local?.cron) {
      const action = args[0] ?? "list";
      const usage = "Usage: /cron [list|status|pause <id>|resume <id>|trigger <id>|remove <id>|once <UTC ISO timestamp> [--skill user|project <id>] -- <prompt>|add <minute> <hour> <day> <month> <weekday> [--skill user|project <id>] -- <prompt>].";
      let command: DesktopCronCommand;
      if ((action === "list" || action === "status") && args.length <= 1) command = { action };
      else if ((action === "pause" || action === "resume" || action === "trigger" || action === "remove") && args.length === 2 && sessionIdPattern.test(args[1]!))
        command = { action, id: args[1]! };
      else if (action === "add" || action === "once") {
        const marker = content.indexOf(" -- ");
        if (marker === -1) return text(usage);
        const fields = content.slice(0, marker).trim().split(/\s+/).slice(2);
        const prompt = content.slice(marker + 4).trim();
        const count = action === "add" ? 5 : 1;
        if (!prompt || prompt.length > 4_000 || /[\u0000-\u001f\u007f]/.test(prompt)
          || (fields.length !== count && fields.length !== count + 3)) return text(usage);
        let skill: { scope: "USER" | "PROJECT"; id: string } | undefined;
        if (fields.length === count + 3) {
          const scope = fields[count + 1];
          const id = fields[count + 2]!;
          if (fields[count] !== "--skill" || (scope !== "user" && scope !== "project") || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) return text(usage);
          skill = { scope: scope === "user" ? "USER" : "PROJECT", id };
        }
        command = { action, expression: fields.slice(0, count).join(" "), prompt, ...(skill === undefined ? {} : { skill }) };
      } else return text(usage);
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try {
        const result = await this.local.cron(command);
        return this.#closed ? failure("CLOSED") : text(result);
      } catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (name === "/worktree" && this.local?.worktree) {
      if (args.length !== 2 || (args[0] !== "create" && args[0] !== "select")) return text("Usage: /worktree create <name> | /worktree select <name>");
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try {
        const target = await this.local.worktree(args[0], args[1]!);
        return this.#closed ? failure("CLOSED") : text(`Worktree: ${target}. Desktop is still bound to its original workspace. Reopen and select this folder to switch.`);
      } catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (name === "/reasoning" && this.local?.reasoning) {
      if (this.#admitting || this.#active) return failure("BUSY");
      if (!this.#sessionId) return failure("NO_SESSION");
      if (args.length > 1) return text("Usage: /reasoning [default|level]");
      this.#admitting = true;
      try {
        const status = await this.#runtime.status({ sessionId: this.#sessionId });
        if (this.#closed) return failure("CLOSED");
        if (!status.session) return failure("NO_SESSION");
        return text(await this.local.reasoning(status.session.provider, status.session.model, args[0]));
      } catch { return text("Unable to set reasoning: unsupported level or profile could not be saved."); }
      finally { this.#admitting = false; }
    }
    if (name === "/provider" || name === "/model") {
      if (args.length > 1) return text(`Usage: ${name} <id>`);
      const status = this.#sessionId ? await this.#runtime.status({ sessionId: this.#sessionId }) : undefined;
      if (!args.length) return text(name === "/provider" ? formatProviderList(this.#runtime.providers(), status?.session?.provider) : `Current model: ${status?.session?.model ?? "none"}. Type /model followed by a space for the adapter default (access not verified).`);
      const reply = await this.request(name === "/provider" ? { type: "create", provider: args[0] } : { type: "create", ...(status?.session?.provider ? { provider: status.session.provider } : {}), model: args[0] });
      return reply.ok ? success({ kind: "session", session: reply.value }) : reply;
    }
    if (["/status", "/session"].includes(name!) && !args.length) {
      const reply = await this.request({ type: "status" });
      return reply.ok ? text(JSON.stringify(reply.value, null, 2)) : reply;
    }
    if (["/new", "/reset", "/resume"].includes(name!)) {
      if ((name === "/resume" && (args.length !== 1 || !sessionIdPattern.test(args[0]!))) || (name !== "/resume" && args.length)) return text("Usage: /new or /resume <id>");
      const reply = await this.request(name === "/resume" ? { type: "resume", sessionId: args[0] } : { type: "create" });
      return reply.ok ? success({ kind: "session", session: reply.value }) : reply;
    }
    if (!["/sessions", "/auth", "/login", "/logout", "/profile"].includes(name!)) return text("Unknown or unavailable command. Run /help.");
    if (!this.local) return text("This command is unavailable on remote connections. Run /help.");
    if (name === "/login" && args.length === 2 && args[0] === "list" && isApiKeyProvider(args[1]) && this.local.listApiKeySlots) {
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try { return this.#closed ? failure("CLOSED") : text(await this.local.listApiKeySlots(args[1]!)); }
      catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (name === "/login" && ((args.length === 1 && isApiKeyProvider(args[0])) || (args.length === 2 && isApiKeyProvider(args[0]) && isApiKeySlot(args[1]))) && this.local.loginApiKey && this.local.requestSecret) {
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try {
        const saved = await this.local.loginApiKey(args[0]!, args[1]);
        if (this.#closed) return failure("CLOSED");
        if (!saved) return text("API-key sign-in cancelled.");
        await this.close();
        return success({ kind: "restart", text: "API key saved in profile OS credential storage. Restart Dragons to use it. Provider access not yet verified." });
      } catch { return failure(this.#closed ? "CLOSED" : "RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (name === "/login") {
      const setup = args.length > 1 ? "Usage: /login <provider>. Never include credentials." : loginSetup(args[0]);
      if (setup) return text(setup);
    }
    if (name === "/logout" && args.length === 2 && isApiKeyProvider(args[0]) && isApiKeySlot(args[1]) && this.local.removeApiKeySlot) {
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try {
        await this.close();
        await this.local.removeApiKeySlot(args[0], args[1]);
        return success({ kind: "restart", text: "Named API-key slot removed. Restart Dragons to continue." });
      } catch { return failure("RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (name === "/auth" || name === "/logout") {
      const providerArgs = name === "/auth" && args[0] === "status" ? args.slice(1) : args;
      if (providerArgs.length > 1) return text(name === "/auth" ? "Usage: /auth [status] [provider]" : "Usage: /logout [provider]");
      if (this.#admitting || this.#active) return failure("BUSY");
      this.#admitting = true;
      try {
        const session = !providerArgs.length && this.#sessionId ? (await this.#runtime.status({ sessionId: this.#sessionId })).session : undefined;
        if (this.#closed) return failure("CLOSED");
        const provider = providerArgs[0] ?? session?.provider ?? this.local.defaultProvider ?? "chatgpt";
        if (provider !== "chatgpt" && !isApiKeyProvider(provider)) return text("This provider has no supported stored login.");
        if (name === "/auth") {
          const output = await this.local.auth(provider);
          return this.#closed ? failure("CLOSED") : text(output);
        }
        if (isApiKeyProvider(provider)) {
          // Quiesce cached credential-bearing adapters before removal, including partial failures.
          await this.close();
          await this.local.logout(provider);
          return success({ kind: "restart", text: "Provider API key removed from profile OS credential storage. Restart Dragons to continue. Environment credentials remain unchanged." });
        }
        const output = await this.local.logout(provider);
        return this.#closed ? failure("CLOSED") : text(output);
      } catch { return failure("RUNTIME_ERROR"); }
      finally { this.#admitting = false; }
    }
    if (!["/profile", "/login"].includes(name!) && args.length) return text(`Usage: ${name}`);
    const action = args[0] ?? "list";
    if (name === "/profile" && !((action === "list" && args.length <= 1) || (["create", "select"].includes(action) && args.length === 2 && isSafeProfileName(args[1]!)))) return text("Usage: /profile [list|create <name>|select <name>]");
    if (this.#admitting || this.#active) return failure("BUSY");
    this.#admitting = true;
    try {
      let output: string;
      switch (name) {
        case "/sessions": output = await this.local.sessions(); break;
        case "/login": output = await this.local.login(); break;
        default:
          if (action === "select") {
            // Stop admissions synchronously before changing persistent profile selection.
            await this.close();
            await this.local.selectProfile(args[1]!);
            return success({ kind: "restart", text: "Profile selected. Restart Dragons Desktop to continue." });
          }
          output = action === "create" ? await this.local.createProfile(args[1]!) : await this.local.profiles();
      }
      return this.#closed ? failure("CLOSED") : text(output);
    } catch { return failure("RUNTIME_ERROR"); }
    finally { this.#admitting = false; }
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
      // Observe rejection immediately, including synchronous throws, without blocking siblings.
      const updateCleanup = Promise.resolve().then(() => this.updates.close()).then(() => false, () => true);
      try { run?.handle.cancel(); } catch { /* Disposal must still run. */ }
      try { await this.local?.close(); } catch { /* Auth shutdown is private. */ }
      try { await this.#runtime.dispose(); } catch { /* Never expose private disposal exceptions. */ }
      if (await updateCleanup) throw new Error("Desktop update cleanup failed.");
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
          if ((event.toolName === "lsp_diagnostics_start" && (event.operation !== "EXECUTE" || !validateLspApproval(event.lspApproval)))
            || (event.toolName !== "lsp_diagnostics_start" && event.lspApproval !== undefined)) {
            this.#runtime.resolveAuthorization({ runId: event.runId, approvalId: event.approvalId, decision: "deny" });
            run.handle.cancel(); continue;
          }
          if ((event.toolName === INLINE_URL_TOOL && (event.operation !== "EXECUTE" || !validateContextUrl(event.contextUrl)))
            || (event.toolName !== INLINE_URL_TOOL && event.contextUrl !== undefined)) {
            this.#runtime.resolveAuthorization({ runId: event.runId, approvalId: event.approvalId, decision: "deny" });
            run.handle.cancel(); continue;
          }
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
