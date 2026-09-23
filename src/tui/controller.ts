import {
  RuntimeRunError,
  type DragonsRuntime,
  type RuntimeApprovalDecision,
  type RuntimeBackgroundTask,
  type RuntimeEvent,
  type RuntimeRunHandle,
  type RuntimeSession,
  type RuntimeStatus,
} from "../runtime.js";
import { observeRuntimeRun } from "../runtime-observation.js";
import { formatProviderList, slashChoices } from "../slash-choices.js";
import { formatSlashHelp } from "../slash-commands.js";
import type { TuiLocalCommands } from "./local-commands.js";

export type TuiState = {
  session?: RuntimeSession;
  status?: RuntimeStatus;
  messages: Array<{ role: "user" | "assistant" | "notice"; text: string }>;
  activity: string[];
  approval?: Extract<RuntimeEvent, { type: "approval_requested" }>;
  background: RuntimeBackgroundTask[];
  busy: boolean;
  error?: string;
};

type Submission = {
  sessionId: string;
  handle?: RuntimeRunHandle;
  assistant?: TuiState["messages"][number];
  cancelled: boolean;
  ended: boolean;
  observing?: boolean;
};

const MAX_MESSAGE_CHARACTERS = 16_000;

/** Presentation state only: the runtime remains the authority for all execution. */
export class TuiController {
  public readonly state: TuiState = { messages: [], activity: [], background: [], busy: false };
  private closed = false;
  private pending?: Promise<void>;
  private closing?: Promise<void>;
  private submission?: Submission;
  private refreshVersion = 0;
  private readonly lifecycle = new AbortController();
  private localController?: AbortController;
  public exitRequested = false;

  constructor(private readonly runtime: DragonsRuntime, private readonly onChange: () => void = () => {}, private readonly localCommands?: TuiLocalCommands) {}

  choices(input: string) {
    return slashChoices(input, ["/help", "/status", "/new", "/resume", "/clear", "/exit", "/provider", "/model", "/context", "/diagnostics", "/mcp", "/tasks", ...(this.localCommands?.names ?? [])], this.runtime.providers(), this.state.session?.provider, this.state.session?.model);
  }

  async initialize(options: { resume?: string; provider?: string; model?: string } = {}): Promise<void> {
    if (this.closed || this.state.session) return;
    if (this.state.busy) { await this.pending; return; }
    this.state.busy = true;
    this.state.error = undefined;
    // Install lifecycle tracking before callbacks or asynchronous runtime admission.
    this.pending = Promise.resolve().then(async () => {
      try {
        if (this.closed) return;
        const session = options.resume !== undefined
          ? await this.runtime.resumeSession(options.resume)
          : await this.runtime.createSession({ provider: options.provider, model: options.model });
        if (this.closed) return;
        this.state.session = session;
        if (options.resume !== undefined) this.message("notice", "Session resumed. The prior transcript is not available through the runtime API.");
        await this.refresh();
      } catch {
        if (!this.closed) this.state.error = "Unable to initialize session. Check the session ID, provider, and model.";
      } finally {
        if (!this.closed) { this.state.busy = false; this.attachObservation(); this.changed(); }
      }
    });
    this.changed();
    await this.pending;
  }

  async submit(content: string): Promise<void> {
    this.attachObservation();
    if (this.closed || this.exitRequested || this.state.busy || !content.trim()) return;
    const command = content.trim();
    if (command.startsWith("/")) {
      const [name, ...args] = command.split(/\s+/);
      if (this.localCommands?.names.includes(name!) || ["/provider", "/model", "/context", "/diagnostics", "/tasks", "/mcp"].includes(name!)) {
        await this.localOperation(async (signal) => {
          if (this.localCommands?.names.includes(name!)) {
            const result = await this.localCommands.execute(command, {
              signal,
              session: this.state.session,
              notice: (text) => { if (!signal.aborted) { this.message("notice", text); this.changed(); } },
            });
            if (result?.exit && !signal.aborted) this.exitRequested = true;
            return;
          }
          if (name === "/provider" || name === "/model") {
            if (args.length > 1) { this.message("notice", `Usage: ${name} [${name === "/provider" ? "id" : "name"}]`); return; }
            if (!args.length) {
              this.message("notice", name === "/provider"
                ? formatProviderList(this.runtime.providers(), this.state.session?.provider)
                : `Model: ${this.state.session?.model ?? "none"}`);
            } else {
              const session = await this.runtime.createSession(name === "/provider" ? { provider: args[0] } : { provider: this.state.session?.provider, model: args[0] });
              if (this.closed) return;
              this.state.session = session;
              this.state.messages = []; this.state.activity = []; this.state.background = [];
              this.state.status = undefined; this.state.approval = undefined; this.submission = undefined;
              this.message("notice", "New session started with the selected provider/model.");
              await this.refresh();
            }
          } else if (name === "/context" || name === "/diagnostics") {
            if (args.length) { this.message("notice", `Usage: ${name}`); return; }
            await this.refresh();
            if (this.closed) return;
            const status = this.state.status;
            this.message("notice", !status ? "No runtime status available." : name === "/context"
              ? `Context: ${status.contextCharacters} / ${status.contextBudgetChars} characters`
              : JSON.stringify(status.recentDiagnostics, null, 2));
          } else if (name === "/mcp") {
            if (!args.length || (args.length === 1 && ["list", "status"].includes(args[0]!))) {
              this.message("notice", this.runtime.mcpStatus().map((s) => `${s.id}: ${s.state} (${s.toolCount} tools)`).join("\n") || "No MCP servers configured.");
            } else if (args.length === 2 && ["connect", "disconnect"].includes(args[0]!)) {
              if (args[0] === "connect") await this.runtime.connectMcp(args[1]!);
              else await this.runtime.disconnectMcp(args[1]!);
              if (!this.closed) this.message("notice", "MCP connection updated.");
            } else this.message("notice", "Usage: /mcp [list|status|connect <id>|disconnect <id>]");
          } else if (name === "/tasks") {
            const sessionId = this.state.session?.id;
            if (!sessionId) { this.message("notice", "No active session."); return; }
            if (!args.length || args.join(" ") === "list") {
              const tasks = await this.runtime.listBackgroundTasks(sessionId);
              if (!this.closed) this.message("notice", tasks.map((task) => `${task.id}: ${task.state}`).join("\n") || "No background tasks.");
            } else if (args.length === 2 && args[0] === "cancel") {
              const cancelled = await this.runtime.cancelBackgroundTask({ sessionId, taskId: args[1]! });
              if (!this.closed) this.message("notice", cancelled ? "Background task cancelled." : "No cancellable task found.");
            } else this.message("notice", "Usage: /tasks [list|cancel <id>]");
          }
        });
      } else if (command === "/exit" || command === "/quit") {
        this.exitRequested = true;
      } else if (command === "/clear") {
        this.state.messages = [];
        this.message("notice", "Display cleared; saved conversation is unchanged. Use /new to start fresh.");
      } else if (name === "/resume" && args.length !== 1) {
        this.message("notice", "Usage: /resume <id>");
      } else if (command === "/help" || command.startsWith("/help ")) {
        this.message("notice", formatSlashHelp(command.slice(5), ["/help", "/status", "/new", "/resume", "/clear", "/exit", "/provider", "/model", "/context", "/diagnostics", "/mcp", "/tasks", ...(this.localCommands?.names ?? [])]));
      } else if (command === "/new" || command === "/reset" || command.startsWith("/resume ")) {
        const previous = this.state.session;
        this.state.busy = true;
        this.state.error = undefined;
        this.refreshVersion += 1;
        this.pending = Promise.resolve().then(async () => {
          try {
            if (this.closed) return;
            const session = command.startsWith("/resume ")
              ? await this.runtime.resumeSession(command.slice(8).trim())
              : await this.runtime.createSession({ provider: previous?.provider, model: previous?.model });
            if (this.closed) return;
            this.state.session = session;
            this.state.messages = [];
            this.state.activity = [];
            this.state.background = [];
            this.state.status = undefined;
            this.state.approval = undefined;
            this.submission = undefined;
            this.message("notice", command.startsWith("/resume ")
              ? "Session resumed. The prior transcript is not available through the runtime API."
              : "New session started.");
            await this.refresh();
          } catch {
            if (!this.closed) this.state.error = "Unable to change session. Check the session ID, workspace, provider, and model.";
          } finally {
            if (!this.closed) { this.state.busy = false; this.attachObservation(); this.changed(); }
          }
        });
        this.changed();
        await this.pending;
      } else if (command === "/status" || command === "/session") {
        await this.localOperation(() => this.refresh());
        if (this.closed) return;
        const session = this.state.session;
        this.message("notice", session
          ? `Session: ${session.id}\nProvider: ${session.provider}\nModel: ${session.model}`
          : "No active session.");
      } else {
        this.message("notice", "This command is not available in this TUI. Run /help for supported local commands.");
      }
      this.changed();
      return;
    }
    if (!this.state.session) {
      this.state.error = "Initialize a session before starting a run.";
      this.changed();
      return;
    }
    // This lock and cancellation token exist before the first await, including admission.
    this.state.busy = true;
    this.state.error = undefined;
    this.state.approval = undefined;
    this.refreshVersion += 1;
    const submission: Submission = { sessionId: this.state.session.id, cancelled: false, ended: false };
    this.submission = submission;
    this.message("user", content);
    this.pending = Promise.resolve().then(() => this.consume(submission, content));
    this.changed();
    await this.pending;
  }

  decide(decision: RuntimeApprovalDecision): boolean {
    const approval = this.state.approval;
    const submission = this.submission;
    if (!approval || !submission || !this.current(submission) || submission.cancelled || submission.ended
      || approval.runId !== submission.handle?.id || approval.sessionId !== submission.sessionId) return false;
    if (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny") return false;
    try {
      const resolved = this.runtime.resolveAuthorization({ runId: approval.runId, approvalId: approval.approvalId, decision });
      // Even a stale runtime request must not remain actionable on screen.
      this.state.approval = undefined;
      this.changed();
      return resolved;
    } catch {
      this.state.error = "Unable to resolve approval. Cancel the run and try again.";
      this.changed();
      return false;
    }
  }

  cancel(): boolean {
    if (this.localController) {
      if (this.localController.signal.aborted) return false;
      this.localController.abort();
      this.changed();
      return true;
    }
    const submission = this.submission;
    if (!submission || submission.observing || !this.current(submission) || submission.cancelled || submission.ended) return false;
    submission.cancelled = true;
    this.state.approval = undefined;
    submission.handle?.cancel();
    this.changed();
    return true;
  }

  async refresh(): Promise<void> {
    const sessionId = this.state.session?.id;
    if (this.closed || !sessionId) return;
    const version = ++this.refreshVersion;
    try {
      const [status, background] = await Promise.all([
        this.runtime.status({ sessionId }), this.runtime.listBackgroundTasks(sessionId),
      ]);
      if (this.closed || version !== this.refreshVersion || this.state.session?.id !== sessionId) return;
      if (status.session?.id !== sessionId) return;
      this.state.status = status;
      this.state.session = status.session;
      this.state.background = background.filter((task) => task.sessionId === sessionId);
      this.attachObservation();
      this.changed();
    } catch {
      if (!this.closed && version === this.refreshVersion && this.state.session?.id === sessionId) {
        this.state.error = "Unable to refresh runtime status. Try refreshing again.";
        this.changed();
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifecycle.abort();
    this.refreshVersion += 1;
    if (this.submission) {
      this.submission.cancelled = true;
      this.submission.handle?.cancel();
    }
    this.state.approval = undefined;
    this.state.busy = false;
    // Dispose immediately, not after startup: disposal closes the runtime admission gate.
    // Still await startup/consumption so a late-returned handle is cancelled and observed.
    this.closing = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.runtime.dispose()), this.pending,
      ]);
      if (results.some((result) => result.status === "rejected")) this.state.error = "Unable to finish runtime shutdown cleanly.";
    })();
    return this.closing;
  }

  private async localOperation(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.localController = controller;
    const signal = AbortSignal.any([this.lifecycle.signal, controller.signal]);
    this.state.busy = true;
    this.state.error = undefined;
    this.refreshVersion += 1;
    this.pending = Promise.resolve().then(async () => {
      try { if (!signal.aborted) await operation(signal); }
      catch { if (!signal.aborted) this.state.error = "Unable to complete local command. Check arguments and configuration."; }
      finally {
        this.localController = undefined;
        if (!this.closed) { this.state.busy = false; this.changed(); }
      }
    });
    this.changed();
    await this.pending;
  }

  private current(submission: Submission): boolean {
    return !this.closed && this.submission === submission && this.state.session?.id === submission.sessionId;
  }

  private attachObservation(): void {
    if (this.closed || this.exitRequested || this.state.busy || !this.state.session) return;
    const handle = observeRuntimeRun(this.runtime, this.state.session.id);
    if (!handle) return;
    const submission: Submission = { sessionId: handle.sessionId, handle, cancelled: false, ended: false, observing: true };
    this.submission = submission;
    this.state.busy = true;
    this.message("notice", "Observing another client's active run. Its owner controls approval and cancellation.");
    this.pending = this.consume(submission, "", handle);
    this.changed();
  }

  private async consume(submission: Submission, content: string, observed?: RuntimeRunHandle): Promise<void> {
    try {
      if (this.closed || submission.cancelled) return;
      const handle = observed ?? await this.runtime.sendUserInput({ sessionId: submission.sessionId, content });
      // A run can reject before its event stream is drained. Observe both outcomes now.
      const outcome = handle.result.then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      submission.handle = handle;
      if (!this.current(submission) || submission.cancelled || handle.sessionId !== submission.sessionId) handle.cancel();
      try {
        for await (const event of handle.events) {
          if (!this.current(submission) || submission.cancelled || submission.ended
            || handle.sessionId !== submission.sessionId || event.runId !== handle.id || event.sessionId !== submission.sessionId) continue;
          await this.event(submission, event);
        }
        const result = await outcome;
        if (this.current(submission) && !submission.cancelled && handle.sessionId === submission.sessionId) {
          if (result.ok) this.assistant(submission, result.result.finalText, false);
          else throw result.error;
        }
      } catch (error) {
        handle.cancel();
        await outcome;
        throw error;
      }
    } catch (error) {
      if (this.current(submission) && !submission.cancelled) {
        this.state.error = error instanceof RuntimeRunError
          ? error.message.slice(0, MAX_MESSAGE_CHARACTERS)
          : "Unable to complete run. Check runtime configuration and try again.";
      }
    } finally {
      if (this.current(submission)) {
        if (submission.cancelled) this.message("notice", "Run cancelled.");
        this.state.approval = undefined;
        // Keep submit locked until the status refresh also settles.
        await this.refresh();
        if (this.current(submission)) {
          this.submission = undefined;
          this.state.busy = false;
          this.changed();
        }
      }
    }
  }

  private async event(submission: Submission, event: RuntimeEvent): Promise<void> {
    switch (event.type) {
      case "run_started":
        this.activity("Run started.");
        break;
      case "assistant_delta":
        this.assistant(submission, event.text, true);
        break;
      case "tool_activity":
        this.activity(`${event.toolName} ${event.operation ?? ""}: ${event.phase}${event.allowed === undefined ? "" : event.allowed ? " (allowed)" : " (denied)"}${event.ok === undefined ? "" : event.ok ? " (ok)" : " (failed)"}${event.output ? `\n${event.output}` : ""}`);
        break;
      case "approval_requested":
        if (event.toolName === "lsp_diagnostics_start") {
          // This optional screen cannot display the complete bounded scope. Never offer a blind approval.
          const denied = this.runtime.resolveAuthorization({ runId: event.runId, approvalId: event.approvalId, decision: "deny" });
          this.message("notice", "LSP startup denied: use CLI or Desktop to review the complete execution scope.");
          if (!denied) this.cancel();
          break;
        }
        this.state.approval = event;
        break;
      case "memory_suggestion": {
        const input = { runId: event.runId, sessionId: event.sessionId, suggestionId: event.suggestionId };
        const acknowledged = this.runtime.acknowledgeMemorySuggestion(input);
        const rejected = acknowledged && await this.runtime.resolveMemorySuggestion({ ...input, decision: "reject" });
        if (this.current(submission) && !submission.cancelled) {
          this.message("notice", rejected
            ? "Memory suggestion rejected: accepting suggestions is not supported by this TUI yet."
            : "Memory suggestion could not be rejected. Cancel this run before continuing.");
          if (!rejected) this.cancel();
        }
        break;
      }
      case "event_stream_truncated":
        this.message("notice", "Runtime event stream truncated; the final answer will replace partial output.");
        break;
      case "run_completed":
        submission.ended = true;
        this.state.approval = undefined;
        this.assistant(submission, event.result.finalText, false);
        this.activity("Run completed.");
        break;
      case "run_failed":
        submission.ended = true;
        this.state.approval = undefined;
        this.state.error = "Run failed. Check runtime configuration and try again.";
        break;
      case "run_cancelled":
        submission.ended = true;
        submission.cancelled = true;
        this.state.approval = undefined;
        break;
    }
    if (this.current(submission)) this.changed();
  }

  private assistant(submission: Submission, text: string, append: boolean): void {
    if (!submission.assistant || !this.state.messages.includes(submission.assistant)) {
      submission.assistant = this.message("assistant", submission.assistant?.text ?? "");
    }
    // Final results are authoritative, not another delta. Intermediate turn text
    // is deliberately replaced rather than duplicating streamed final output.
    submission.assistant.text = (append ? submission.assistant.text + text : text).slice(0, MAX_MESSAGE_CHARACTERS);
  }

  private message(role: TuiState["messages"][number]["role"], text: string): TuiState["messages"][number] {
    const message = { role, text: text.slice(0, MAX_MESSAGE_CHARACTERS) };
    this.state.messages.push(message);
    if (this.state.messages.length > 100) this.state.messages.splice(0, this.state.messages.length - 100);
    return message;
  }

  private activity(text: string): void {
    this.state.activity.push(text.slice(0, 2000));
    if (this.state.activity.length > 50) this.state.activity.splice(0, this.state.activity.length - 50);
  }

  private changed(): void {
    if (this.closed) return;
    try { this.onChange(); }
    catch { this.state.error = "Unable to update the TUI display."; }
  }
}
