import type { DragonsRuntime, RuntimeEvent, RuntimeRunHandle, RuntimeRunResult, RuntimeSession, RuntimeStatus, RuntimeStatusOptions } from "./runtime.js";

export type SharedRuntimeStatus = RuntimeStatus & {
  shared: { clientId: string; revision: number; ownerClientId?: string };
};
export interface SharedClientRuntime extends DragonsRuntime {
  observeRun(sessionId: string): RuntimeRunHandle | undefined;
  status(options?: RuntimeStatusOptions): Promise<SharedRuntimeStatus>;
};
export type SharedRuntimeHost = { connect(clientId: string): SharedClientRuntime; close(): Promise<void> };

const MAX_CLIENTS = 32;
const MAX_SESSIONS = 128;
const MAX_EVENTS = 128;
const MAX_BYTES = 512 * 1024;

/** A direct iterator avoids the hidden, unbounded next-request queue of generators. */
class Subscription implements AsyncIterable<RuntimeEvent> {
  private values: { event: RuntimeEvent; bytes: number }[] = [];
  private waiters: ((value: IteratorResult<RuntimeEvent>) => void)[] = [];
  private bytes = 0;
  private closed = false;
  constructor(private readonly overflow: () => void, private readonly detach: () => void, private readonly discarded: () => void) {}
  push(event: RuntimeEvent): void {
    if (this.closed) return;
    const copy = structuredClone(event);
    const bytes = Buffer.byteLength(JSON.stringify(copy));
    if (bytes > MAX_BYTES || this.values.length >= MAX_EVENTS || this.bytes + bytes > MAX_BYTES) {
      this.finish(true);
      this.overflow();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: copy });
    else { this.values.push({ event: copy, bytes }); this.bytes += bytes; }
  }
  finish(discard = false): void {
    this.closed = true;
    if (discard) { this.values = []; this.bytes = 0; this.discarded(); }
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) { this.bytes -= value.bytes; return Promise.resolve({ done: false, value: value.event }); }
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        if (this.waiters.length >= MAX_EVENTS) {
          this.finish(true); this.overflow();
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: async () => { this.finish(true); this.detach(); return { done: true, value: undefined }; },
    };
  }
}

type Client = {
  id: string; disposed: boolean; switching: boolean; sessionId?: string; seen?: number;
  subscription?: Subscription; owned?: Active; disposal?: Promise<void>;
};
type Session = { summary: RuntimeSession; revision: number; active?: Active };
type Active = {
  owner: Client; session: Session; handle?: RuntimeRunHandle;
  subscribers: Map<Client, Subscription>; settled: boolean;
  results: Map<Client, { resolve(value: RuntimeRunResult): void; reject(error: unknown): void }>;
  admission?: Promise<RuntimeRunHandle>; completion?: Promise<RuntimeRunResult>;
};

/** Trusted hosts authenticate and authorize connections; client IDs are not credentials.
 * All execution and sanitization remain in the injected core. Do not share that core
 * with independent writers: revisions describe writes admitted through this host.
 */
export function createSharedRuntimeHost(runtime: DragonsRuntime): SharedRuntimeHost {
  const clients = new Map<string, Client>();
  const sessions = new Map<string, Session>();
  const backgroundOwners = new Map<string, Client>();
  let pendingSessions = 0;
  let pendingBackground = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const open = (client: Client): void => {
    if (closed || client.disposed) throw new Error("Shared runtime client is disposed.");
  };
  const attached = (client: Client, id: string): Session => {
    open(client);
    if (client.switching || typeof id !== "string" || client.sessionId !== id || !sessions.has(id)) {
      throw new Error("Attach the shared runtime session first.");
    }
    return sessions.get(id)!;
  };
  const detach = (client: Client): void => {
    if (!client.subscription) return;
    client.subscription.finish(true);
    for (const session of sessions.values()) session.active?.subscribers.delete(client);
    client.subscription = undefined;
  };
  const owns = (client: Client, runId: string): boolean => !closed && !client.disposed
    && client.owned?.handle?.id === runId && !client.owned.settled;
  const subscribe = (client: Client, active: Active, observer: boolean): RuntimeRunHandle => {
    detach(client);
    const handle = active.handle!;
    let queue!: Subscription;
    let rejectDetached!: (error: Error) => void;
    const result = new Promise<RuntimeRunResult>((resolve, reject) => {
      rejectDetached = reject;
      active.results.set(client, { resolve: (value) => resolve(structuredClone(value)), reject });
    });
    const remove = (): void => {
      active.subscribers.delete(client);
      if (client.subscription === queue) client.subscription = undefined;
    };
    queue = new Subscription(() => {
      remove();
      if (!observer) handle.cancel();
    }, () => { remove(); if (!observer) handle.cancel(); }, () => { if (observer) { active.results.delete(client); rejectDetached(new Error("Shared run observation cancelled.")); } });
    active.subscribers.set(client, queue);
    client.subscription = queue;
    if (observer) {
      queue.push({ type: "run_started", runId: handle.id, sessionId: handle.sessionId,
        provider: active.session.summary.provider, model: active.session.summary.model });
      queue.push({ type: "event_stream_truncated", runId: handle.id, sessionId: handle.sessionId });
    }
    void result.catch(() => {});
    return { id: handle.id, sessionId: handle.sessionId, events: queue, result,
      cancel: () => !observer && owns(client, handle.id) ? handle.cancel() : false };
  };
  const dispose = (client: Client): Promise<void> => {
    if (client.disposal) return client.disposal;
    client.disposed = true;
    detach(client);
    const owned = client.owned;
    owned?.handle?.cancel();
    client.disposal = (async () => {
      if (owned?.admission) await owned.admission.catch(() => {});
      if (owned?.completion) await owned.completion.catch(() => {});
      if (clients.get(client.id) === client) clients.delete(client.id);
      // Background jobs deliberately survive disconnection, but never transfer authority
      // to another connection that happens to reuse the same display ID.
      for (const [id, owner] of backgroundOwners) if (owner === client) backgroundOwners.delete(id);
    })();
    return client.disposal;
  };

  return Object.freeze({
    connect(clientId: string): SharedClientRuntime {
      if (closed) throw new Error("Shared runtime host is closed.");
      if (typeof clientId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(clientId)) throw new Error("Invalid shared runtime client ID.");
      if (clients.has(clientId)) throw new Error("Shared runtime client ID is already connected.");
      if (clients.size >= MAX_CLIENTS) throw new Error("Shared runtime client limit reached.");
      const client: Client = { id: clientId, disposed: false, switching: false };
      clients.set(clientId, client);
      const attach = async (load: () => Promise<RuntimeSession>, existingId?: string): Promise<RuntimeSession> => {
        open(client);
        if (client.switching || client.owned) throw new Error("Cannot switch sessions during an owned active run or attachment.");
        const reservation = !existingId || !sessions.has(existingId);
        if (reservation && sessions.size + pendingSessions >= MAX_SESSIONS) throw new Error("Shared runtime session limit reached.");
        client.switching = true;
        if (reservation) pendingSessions++;
        try {
          const revision = existingId ? sessions.get(existingId)?.revision : undefined;
          const summary = await load();
          open(client);
          let session = sessions.get(summary.id);
          if (!session) { session = { summary: structuredClone(summary), revision: 0 }; sessions.set(summary.id, session); }
          detach(client);
          client.sessionId = summary.id;
          client.seen = revision ?? session.revision;
          return structuredClone(summary);
        } finally { client.switching = false; if (reservation) pendingSessions--; }
      };
      const facade: SharedClientRuntime = {
        providers() { open(client); return structuredClone(runtime.providers()); },
        createSession: (options) => attach(() => runtime.createSession(options)),
        resumeSession: (id) => attach(() => runtime.resumeSession(id), id),
        async status(options = {}) {
          open(client);
          const id = options.sessionId ?? client.sessionId;
          const session = id === undefined ? undefined : attached(client, id);
          const revision = session?.revision ?? 0;
          const ownerClientId = session?.active?.owner.id;
          const result = await runtime.status(id === undefined ? {} : { sessionId: id });
          open(client);
          if (id === client.sessionId) client.seen = revision;
          return { ...structuredClone(result), shared: { clientId, revision, ...(ownerClientId === undefined ? {} : { ownerClientId }) } };
        },
        mcpStatus() { open(client); return structuredClone(runtime.mcpStatus()); },
        async connectMcp() { throw new Error("MCP connections are host-only."); },
        async disconnectMcp() { throw new Error("MCP connections are host-only."); },
        async startBackgroundTask(input) {
          const session = attached(client, input?.sessionId);
          if (session.active) throw new Error("Session has an active foreground run.");
          // Bound ownership metadata independently of the core task manager.
          if (backgroundOwners.size + pendingBackground >= MAX_SESSIONS) throw new Error("Shared background ownership limit reached.");
          pendingBackground++;
          try {
            const task = await runtime.startBackgroundTask(input);
            if (!closed && !client.disposed) backgroundOwners.set(task.id, client);
            return structuredClone(task);
          } finally { pendingBackground--; }
        },
        async listBackgroundTasks(id) {
          attached(client, id);
          const tasks = await runtime.listBackgroundTasks(id);
          for (const task of tasks) if (["completed", "failed", "cancelled"].includes(task.state)) backgroundOwners.delete(task.id);
          return structuredClone(tasks);
        },
        async cancelBackgroundTask(input) {
          open(client);
          if (client.sessionId !== input?.sessionId || backgroundOwners.get(input?.taskId) !== client) return false;
          return runtime.cancelBackgroundTask(input);
        },
        async sendUserInput(input) {
          const session = attached(client, input?.sessionId);
          if (session.active) throw new Error("Shared session already has an active owner.");
          if (client.seen !== session.revision) throw new Error("Shared session revision is stale; refresh status before sending.");
          const active: Active = { owner: client, session, subscribers: new Map(), results: new Map(), settled: false };
          // This reservation MUST precede the first await (including core admission).
          session.active = active; client.owned = active; session.revision++;
          const release = (): void => {
            active.settled = true;
            if (session.active === active) { session.active = undefined; session.revision++; }
            if (client.owned === active) client.owned = undefined;
          };
          active.admission = (async () => {
            try {
              const handle = await runtime.sendUserInput(input);
              active.handle = handle;
              active.completion = handle.result.then((result) => {
                release();
                for (const pending of active.results.values()) pending.resolve(result);
                active.results.clear();
                return result;
              }, (error: unknown) => {
                release();
                for (const pending of active.results.values()) pending.reject(error);
                active.results.clear();
                throw error;
              });
              void active.completion.catch(() => {});
              if (closed || client.disposed) handle.cancel();
              const owner = subscribe(client, active, false);
              if (closed || client.disposed) detach(client);
              // Exactly one consumer of the underlying runtime stream per run.
              void (async () => {
                try {
                  for await (const event of handle.events) {
                    for (const [subscriber, queue] of active.subscribers) {
                      if (subscriber !== client && (event.type === "approval_requested" || event.type === "memory_suggestion")) continue;
                      queue.push(event);
                    }
                  }
                } catch { handle.cancel(); }
                finally {
                  for (const [subscriber, queue] of active.subscribers) {
                    queue.finish();
                  }
                  active.subscribers.clear();
                }
              })();
              return owner;
            } catch (error) { release(); throw error; }
          })();
          return active.admission;
        },
        observeRun(id) {
          const session = attached(client, id);
          const active = session.active;
          if (!active?.handle || active.settled) return undefined;
          if (active.owner === client) throw new Error("The owner must consume its original run handle.");
          return subscribe(client, active, true);
        },
        cancelRun: (id) => owns(client, id) ? runtime.cancelRun(id) : false,
        resolveAuthorization: (input) => owns(client, input?.runId) && input?.decision !== "allow_session" ? runtime.resolveAuthorization(input) : false,
        acknowledgeMemorySuggestion: (input) => owns(client, input?.runId) && client.sessionId === input?.sessionId ? runtime.acknowledgeMemorySuggestion(input) : false,
        resolveMemorySuggestion: async (input) => owns(client, input?.runId) && client.sessionId === input?.sessionId ? runtime.resolveMemorySuggestion(input) : false,
        dispose: () => dispose(client),
      };
      return Object.freeze(facade);
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      const disposals = [...clients.values()].map(dispose);
      closing = (async () => { await runtime.dispose(); await Promise.all(disposals); sessions.clear(); backgroundOwners.clear(); })();
      return closing;
    },
  });
}
