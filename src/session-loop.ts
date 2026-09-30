export type SessionLoopConfig = {
  /** Session-local only; the host never persists this prompt or treats it as authorization. */
  sessionId: string;
  prompt: string;
  intervalMs: number;
  maxRuns: number;
  /** A heartbeat fires only after the session has been idle this long. Omit for a regular loop. */
  idleMs?: number;
};

export type SessionLoopStatus = { running: boolean; completed: number; active: boolean; sessionId: string };

/** Scheduling only: a trusted host supplies a READ-only run callback and owns all tool approval. */
export class SessionLoop {
  private readonly config: SessionLoopConfig;
  private readonly run: (sessionId: string, prompt: string, signal: AbortSignal) => Promise<void>;
  private readonly isBusy: (sessionId: string) => boolean | Promise<boolean>;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<boolean>;
  private lastActivityAt: number;
  private completed = 0;
  private stopped = false;
  private started = false;

  constructor(options: {
    config: SessionLoopConfig;
    run: (sessionId: string, prompt: string, signal: AbortSignal) => Promise<void>;
    isBusy: (sessionId: string) => boolean | Promise<boolean>;
    onError: (error: unknown) => void;
    now?: () => number;
  }) {
    const { config } = options;
    if (!config || typeof config.sessionId !== "string" || !config.sessionId || config.sessionId.length > 128
      || typeof config.prompt !== "string" || !config.prompt.trim() || config.prompt.length > 4_000
      || !Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1_000 || config.intervalMs > 3_600_000
      || !Number.isSafeInteger(config.maxRuns) || config.maxRuns < 1 || config.maxRuns > 64
      || (config.idleMs !== undefined && (!Number.isSafeInteger(config.idleMs) || config.idleMs < config.intervalMs || config.idleMs > 86_400_000))
      || typeof options.run !== "function" || typeof options.isBusy !== "function" || typeof options.onError !== "function") {
      throw new Error("Invalid session loop configuration.");
    }
    this.config = { ...config };
    this.run = options.run;
    this.isBusy = options.isBusy;
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
    this.lastActivityAt = this.now();
  }

  status(): SessionLoopStatus {
    return { running: this.started && !this.stopped, completed: this.completed, active: this.inFlight !== undefined, sessionId: this.config.sessionId };
  }

  markActivity(): void {
    if (!this.stopped) this.lastActivityAt = this.now();
  }

  start(): void {
    if (this.started || this.stopped) throw new Error("Session loop already started or stopped.");
    this.started = true;
    this.lastActivityAt = this.now();
    this.timer = setInterval(() => { void this.tick().catch((error: unknown) => {
      this.halt();
      try { this.onError(error); } catch { /* A host observer cannot restart or crash the timer. */ }
    }); }, this.config.intervalMs);
  }

  async tick(): Promise<boolean> {
    if (!this.started || this.stopped || this.inFlight || this.completed >= this.config.maxRuns) return false;
    if (this.config.idleMs !== undefined && this.now() - this.lastActivityAt < this.config.idleMs) return false;
    // Claim the slot before awaiting a host status check: concurrent timer ticks must not overlap.
    const work = (async (): Promise<boolean> => {
      if (await this.isBusy(this.config.sessionId) || this.stopped) return false;
      await this.run(this.config.sessionId, this.config.prompt, this.controller.signal);
      if (this.stopped || this.controller.signal.aborted) return false;
      this.completed += 1;
      if (this.config.idleMs !== undefined) this.lastActivityAt = this.now();
      if (this.completed >= this.config.maxRuns) this.halt();
      return true;
    })();
    this.inFlight = work;
    try { return await work; }
    catch (error: unknown) {
      if (this.stopped && this.controller.signal.aborted) return false;
      this.halt();
      throw error;
    } finally { if (this.inFlight === work) this.inFlight = undefined; }
  }

  private halt(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async stop(): Promise<void> {
    this.halt();
    this.controller.abort();
    const active = this.inFlight;
    if (!active) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      // tick() owns the run error; shutdown only waits for settlement.
      await Promise.race([active.catch(() => {}), new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Session loop shutdown timed out.")), 5_000);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
}
