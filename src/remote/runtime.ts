import { RemoteClient } from "./client.js";
import { RuntimeRunError, type DragonsRuntime, type RuntimeEvent, type RuntimeRunHandle, type RuntimeRunResult, type RuntimeSession, type RuntimeProvider, type RuntimeStatus, type RuntimeBackgroundTask } from "../runtime.js";
import type { ObservableRuntime } from "../runtime-observation.js";
import type { DesktopCommand } from "../desktop/bridge.js";

class EventQueue implements AsyncIterable<RuntimeEvent> {
  values: RuntimeEvent[] = [];
  bytes = 0;
  closed = false;
  waiter?: (value: IteratorResult<RuntimeEvent>) => void;
  push(event: RuntimeEvent): boolean {
    if (this.closed) return false;
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve({ done: false, value: event }); return true; }
    const size = JSON.stringify(event).length;
    if (this.values.length >= 128 || this.bytes + size > 524288) return false;
    this.bytes += size; this.values.push(event); return true;
  }
  close(): void { this.closed = true; this.waiter?.({ done: true, value: undefined }); this.waiter = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> { return { next: () => {
    const value = this.values.shift();
    if (value) { this.bytes -= JSON.stringify(value).length; return Promise.resolve({ done: false, value }); }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    if (this.waiter) return Promise.reject(new Error("Only one event read may be pending."));
    return new Promise((resolve) => { this.waiter = resolve; });
  } }; }
}

type ClientRun = { handle: RuntimeRunHandle; queue: EventQueue; owner: boolean; done: boolean; approvals: Set<string>; resolve(value: RuntimeRunResult): void; reject(error: Error): void };

/** A presentation-only runtime facade for CLI/TUI and desktop connected to a shared host. */
export async function connectRemoteRuntime(options: { url: string; token: string }): Promise<ObservableRuntime> {
  let client: RemoteClient;
  let providers: RuntimeProvider[] = [];
  let session: RuntimeSession | undefined;
  let run: ClientRun | undefined;
  let sending = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let admitting = false;
  function assertOpen(): void { if (closed) throw new RuntimeRunError("Remote runtime is closed."); }
  async function request<T>(command: DesktopCommand): Promise<T> {
    assertOpen(); const reply = await client.request<T>(command);
    if (!reply.ok) throw new RuntimeRunError("Remote command rejected. Refresh status or resume before retrying a stale session.");
    return reply.value;
  }
  function end(error: Error): void {
    if (run && !run.done) { run.done = true; run.approvals.clear(); run.queue.close(); run.reject(error); }
  }
  function control(command: DesktopCommand): boolean {
    if (closed) return false;
    void request(command).catch(() => { void dispose(); }); return true;
  }
  function createRun(id: string, sessionId: string, owner: boolean): ClientRun {
    const queue = new EventQueue();
    let resolve!: ClientRun["resolve"]; let reject!: ClientRun["reject"];
    const result = new Promise<RuntimeRunResult>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => {});
    const value: ClientRun = { queue, owner, done: false, approvals: new Set(), resolve, reject,
      handle: { id, sessionId, events: queue, result, cancel: () => owner && !value.done && control({ type: "cancel", runId: id }) },
    };
    return value;
  }
  function receive(event: RuntimeEvent): void {
    if (closed || event.sessionId !== session?.id) return;
    if (event.type === "run_started" && (!run || run.done)) run = createRun(event.runId, event.sessionId, sending);
    if (!run || run.handle.id !== event.runId || run.done) return;
    if (event.type === "approval_requested") {
      if (!run.owner) return;
      run.approvals.add(event.approvalId);
    }
    if (!run.queue.push(event)) { end(new RuntimeRunError("Remote event consumer exceeded its capacity.")); void dispose(); return; }
    if (event.type === "run_completed") { run.done = true; run.approvals.clear(); run.queue.close(); run.resolve(event.result); }
    else if (event.type === "run_failed" || event.type === "run_cancelled") end(new RuntimeRunError(event.type === "run_failed" ? "Remote run failed." : "Remote run cancelled."));
  }
  function dispose(): Promise<void> {
    if (closing) return closing;
    closed = true; end(new RuntimeRunError("Remote client disconnected."));
    closing = client.close(); return closing;
  }
  function ensureObservation(status: RuntimeStatus): void {
    const id = status.activeRunId;
    if (sending || !id || !session || run?.handle.id === id || (run && !run.done)) return;
    run = createRun(id, session.id, false);
    // HTTP replies and SSE use separate sockets: do not depend on their arrival order.
    run.queue.push({ type: "run_started", runId: id, sessionId: session.id, provider: session.provider, model: session.model });
    run.queue.push({ type: "event_stream_truncated", runId: id, sessionId: session.id });
  }
  client = await RemoteClient.connect({ ...options, onEvent: receive });
  void client.disconnected.then(() => { closed = true; end(new RuntimeRunError("Remote client disconnected.")); });
  try { providers = await request<RuntimeProvider[]>({ type: "providers" }); } catch (error) { await dispose(); throw error; }
  const unsupported = (): never => { throw new RuntimeRunError("This capability is controlled by the shared runtime host."); };
  async function attach(command: Extract<DesktopCommand, { type: "create" | "resume" }>): Promise<RuntimeSession> {
    assertOpen(); if (admitting || (run && !run.done)) throw new RuntimeRunError("Remote runtime is busy.");
    admitting = true;
    // Set the known session ID before resume so early observation events are not lost.
    const previous = session;
    if (command.type === "resume") session = { id: command.sessionId } as RuntimeSession;
    try {
      const value = await request<RuntimeSession>(command); assertOpen(); session = value;
      if (command.type === "resume") ensureObservation(await request<RuntimeStatus>({ type: "status" }));
      return value;
    }
    catch (error) { session = previous; throw error; } finally { admitting = false; }
  }
  return Object.freeze({
    providers: () => { assertOpen(); return structuredClone(providers); },
    createSession: (input = {}) => attach({ type: "create", ...(input.provider === undefined ? {} : { provider: input.provider }), ...(input.model === undefined ? {} : { model: input.model }) }),
    resumeSession: (sessionId) => attach({ type: "resume", sessionId }),
    status: async (input = {}) => {
      if (input.sessionId !== undefined && input.sessionId !== session?.id) throw new RuntimeRunError("Session is not attached.");
      const status = await request<RuntimeStatus>({ type: "status" }); ensureObservation(status); return status;
    },
    listBackgroundTasks: async (sessionId) => { if (sessionId !== session?.id) throw new RuntimeRunError("Session is not attached."); return request<RuntimeBackgroundTask[]>({ type: "background" }); },
    sendUserInput: async (input) => {
      assertOpen(); if (admitting || sending || !session || input.sessionId !== session.id || (run && !run.done)) throw new RuntimeRunError("Remote session unavailable or busy.");
      sending = true; run = undefined;
      try {
        const value = await request<{ runId: string; sessionId: string }>({ type: "send", sessionId: input.sessionId, content: input.content });
        assertOpen(); run ??= createRun(value.runId, value.sessionId, true);
        return run.handle;
      } finally { sending = false; }
    },
    observeRun: (sessionId) => { assertOpen(); return sessionId === session?.id && run && !run.owner && !run.done ? run.handle : undefined; },
    cancelRun: (runId) => !!run && run.owner && !run.done && run.handle.id === runId && control({ type: "cancel", runId }),
    resolveAuthorization: (input) => {
      if (!run || !run.owner || run.done || input.runId !== run.handle.id || (input.decision !== "allow_once" && input.decision !== "deny") || !run.approvals.delete(input.approvalId)) return false;
      return control({ type: "approve", sessionId: run.handle.sessionId, runId: input.runId, approvalId: input.approvalId, decision: input.decision });
    },
    mcpStatus: unsupported, connectMcp: unsupported, disconnectMcp: unsupported,
    startBackgroundTask: unsupported, cancelBackgroundTask: unsupported,
    acknowledgeMemorySuggestion: () => false, resolveMemorySuggestion: async () => false,
    dispose,
  } satisfies ObservableRuntime);
}
