import type { DesktopBridgeReply, DesktopCommand } from "../desktop/bridge.js";
import type { RuntimeEvent } from "../runtime.js";

export type RemoteClientOptions = {
  url: string;
  /** Transport credential only; provider credentials stay on the runtime host. */
  token: string;
  onEvent: (event: RuntimeEvent) => void;
};

const eventTypes = new Set(["run_started", "assistant_delta", "tool_activity", "approval_requested", "memory_suggestion", "event_stream_truncated", "run_completed", "run_failed", "run_cancelled"]);

/** Browser-compatible fetch/SSE client. No automatic replay of effectful commands. */
export class RemoteClient {
  readonly #url: string;
  readonly #token: string;
  readonly #onEvent: RemoteClientOptions["onEvent"];
  readonly #stream = new AbortController();
  #connectionId?: string;
  #sequence = 0;
  #closed = false;
  #closing?: Promise<void>;
  #queued = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #finish!: () => void;
  readonly disconnected: Promise<void>;

  private constructor(options: RemoteClientOptions) {
    const url = new URL(options.url);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]")))
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid remote endpoint.");
    if (typeof options.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) throw new Error("Invalid transport credential.");
    this.#url = url.origin; this.#token = options.token; this.#onEvent = options.onEvent;
    this.disconnected = new Promise((resolve) => { this.#finish = resolve; });
  }

  static async connect(options: RemoteClientOptions): Promise<RemoteClient> {
    const client = new RemoteClient(options);
    try {
      const reply = await client.#fetch("/connect", "POST", {});
      const value = reply.ok ? reply.value as { connectionId?: unknown } : undefined;
      if (!value || typeof value.connectionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.connectionId)) throw new Error("Remote connection rejected.");
      client.#connectionId = value.connectionId;
      const timeout = setTimeout(() => client.#stream.abort(), 10000);
      let response: Response;
      try { response = await fetch(`${client.#url}/events`, {
        headers: client.#headers(), signal: client.#stream.signal, redirect: "error", credentials: "omit", cache: "no-store",
      }); } finally { clearTimeout(timeout); }
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("Remote event stream unavailable.");
      void client.#consume(response.body).catch(() => {}).finally(() => { void client.close(); });
      return client;
    } catch {
      await client.close();
      throw new Error("Remote connection failed. Check endpoint and transport authentication.");
    }
  }

  request<T = unknown>(command: DesktopCommand): Promise<DesktopBridgeReply<T>> {
    if (this.#closed || this.#queued >= 16) return Promise.reject(new Error("Remote client unavailable or busy."));
    this.#queued++;
    const request = this.#tail.then(async () => {
      if (this.#closed) throw new Error("Remote client disconnected.");
      try { return await this.#fetch("/command", "POST", { sequence: ++this.#sequence, command }) as DesktopBridgeReply<T>; }
      catch {
        // The host may have admitted the command even if its reply was lost. Never retry it.
        await this.close();
        throw new Error("Remote command outcome unavailable. Reconnect and inspect the session; do not automatically resend.");
      }
    }).finally(() => { this.#queued--; });
    this.#tail = request.catch(() => {});
    return request;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#stream.abort();
    this.#closing = Promise.resolve().then(async () => {
      try { if (this.#connectionId) await this.#fetch("/connection", "DELETE"); } catch { /* Disconnect is fail closed at the host. */ }
      finally { this.#finish(); }
    });
    return this.#closing;
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, ...(this.#connectionId ? { "x-dragons-connection": this.#connectionId } : {}) };
  }

  async #fetch(path: string, method: string, body?: unknown): Promise<DesktopBridgeReply> {
    const response = await fetch(this.#url + path, {
      method, headers: { ...this.#headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000), redirect: "error", credentials: "omit", cache: "no-store",
    });
    if (!response.body) throw new Error("Empty remote reply.");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 524288) throw new Error("Remote reply exceeds limit."); chunks.push(next.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // A non-2xx refusal may precede server sequence consumption. Do not keep a
    // desynchronized connection alive or guess whether it is safe to retry.
    if (!response.ok) throw new Error("Remote transport request rejected.");
    const reply: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!reply || typeof reply !== "object" || !("ok" in reply) || typeof reply.ok !== "boolean") throw new Error("Malformed remote reply.");
    return reply as DesktopBridgeReply;
  }

  async #consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader(); const decoder = new TextDecoder(); let pending = "";
    try {
      while (!this.#closed) {
        const next = await reader.read(); if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        if (pending.length > 524288) throw new Error("Remote event exceeds limit.");
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const line = frame.split("\n").find((part) => part.startsWith("data:"));
          if (!line) continue;
          const event: unknown = JSON.parse(line.slice(5).trimStart());
          if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string" || !eventTypes.has(event.type)
            || !("runId" in event) || typeof event.runId !== "string" || !("sessionId" in event) || typeof event.sessionId !== "string") throw new Error("Malformed remote event.");
          this.#onEvent(event as RuntimeEvent);
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
}
