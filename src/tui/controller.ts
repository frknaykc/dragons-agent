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

  constructor(private readonly runtime: DragonsRuntime, private readonly onChange: () => void = () => {}) {}

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
        if (!this.closed) { this.state.busy = false; this.changed(); }
      }
    });
    this.changed();
    await this.pending;
  }

  async submit(content: string): Promise<void> {
    if (this.closed || this.state.busy || !content.trim()) return;
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
    const submission = this.submission;
    if (!submission || !this.current(submission) || submission.cancelled || submission.ended) return false;
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

  private current(submission: Submission): boolean {
    return !this.closed && this.submission === submission && this.state.session?.id === submission.sessionId;
  }

  private async consume(submission: Submission, content: string): Promise<void> {
    try {
      if (this.closed || submission.cancelled) return;
      const handle = await this.runtime.sendUserInput({ sessionId: submission.sessionId, content });
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
