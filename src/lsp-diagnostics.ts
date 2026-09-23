import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeTextRedactor } from "./runtime-redaction.js";

/** Trusted host configuration only. Never derived from workspace files or model arguments. */
export type LspConfig = { command: string; args: string[]; languageId: string; extensions: string[]; timeoutMilliseconds: number };
export function parseLspConfig(value: unknown): LspConfig {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v)
    || Object.keys(v).some((k) => !["command", "args", "languageId", "extensions", "timeoutMilliseconds"].includes(k))
    || typeof v.command !== "string" || !isAbsolute(v.command) || v.command.length > 2048 || /[\x00-\x1f]/.test(v.command)
    || !Array.isArray(v.args) || v.args.length > 16 || v.args.some((a) => typeof a !== "string" || a.length > 2048 || /[\x00-\x1f]/.test(a))
    || typeof v.languageId !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(v.languageId)
    || !Array.isArray(v.extensions) || !v.extensions.length || v.extensions.length > 16
    || v.extensions.some((e) => typeof e !== "string" || !/^\.[a-zA-Z0-9]{1,16}$/.test(e))
    || (v.timeoutMilliseconds !== undefined && (!Number.isInteger(v.timeoutMilliseconds) || (v.timeoutMilliseconds as number) < 100 || (v.timeoutMilliseconds as number) > 10000))) {
    throw new Error("Dragons config lsp requires an absolute executable, bounded args/language/extensions and a 100–10000ms timeout.");
  }
  return { command: v.command, args: [...v.args] as string[], languageId: v.languageId, extensions: [...v.extensions] as string[], timeoutMilliseconds: (v.timeoutMilliseconds as number | undefined) ?? 3000 };
}

export function lspMatches(config: LspConfig, path: string): boolean { return config.extensions.includes(extname(path)); }
export function safeLspText(text: string, limit = 512): string {
  const redactor = new RuntimeTextRedactor();
  return (redactor.push(text) + redactor.finish())
    .replace(/(?:gh[pousr]_|github_pat_|AKIA|AIza)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/\\?#@"'`<>]+@/gi, "$1[REDACTED]@")
    .replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, " ").slice(0, limit);
}
const FRAME = 262144;
const TOTAL = 2097152;
type Message = Record<string, any>;

/** One document/process per approved inspection: no shared cache, stale sessions or auto-restarts. */
export async function collectLspDiagnostics(config: LspConfig, workspace: string, path: string, signal?: AbortSignal): Promise<string> {
  let root: string, file: string, text: string;
  try {
    if (signal?.aborted) return "LSP: cancelled.";
    root = await realpath(workspace);
    file = resolve(root, path);
    const rel = relative(root, file);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || path.length > 512) return "LSP: unsafe path excluded.";
    // Never send recognized credential files; this is intentionally not a complete secret detector.
    if (/(?:^|[\\/])(?:\.env[^\\/]*|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.dragons|\.hermes|credentials?[^\\/]*|auth\.json|secrets?[^\\/]*|id_rsa[^\\/]*|id_ed25519[^\\/]*|\.npmrc|\.netrc)(?:[\\/]|$)|\.(?:pem|key|p12|pfx|keystore)$/i.test(rel)) return "LSP: sensitive path excluded.";
    if (await realpath(file) !== file || (await lstat(file)).isSymbolicLink()) return "LSP: symlink excluded.";
    if (!(await lstat(file)).isFile()) return "LSP: unsupported document type.";
    // Nonblocking open also prevents a replacement FIFO from hanging before fstat.
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 131072) return "LSP: unsupported document (type, links or size).";
      const bytes = Buffer.alloc(131073);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 131072) return "LSP: document too large.";
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
      if (text.includes("\0")) return "LSP: binary document excluded.";
    } finally { await handle.close(); }
  } catch { return "LSP: document unavailable (deleted or unsafe)."; }
  if (signal?.aborted) return "LSP: cancelled.";
  const uri = pathToFileURL(file).href;
  if (Buffer.byteLength(JSON.stringify({ uri, text })) > FRAME - 1024) return "LSP: encoded document too large.";
  let child: ChildProcessWithoutNullStreams;
  try {
    // No shell, PATH search, inherited credentials, workspace discovery, install or project-controlled env.
    child = spawn(config.command, config.args, { cwd: root, shell: false, windowsHide: true, detached: process.platform !== "win32", env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {} });
  } catch { return "LSP: server unavailable."; }
  return await new Promise<string>((resolveResult) => {
    const buffer = Buffer.alloc(FRAME + 8196);
    let used = 0, bodyStart = 0, frameEnd = 0, total = 0, frames = 0, done = false, opened = false, pull = false;
    let closed = false, completed = false, outputLimited = false;
    const kill = (): void => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (report: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Cleanup is awaited, bounded, and owns the process even when initialization failed.
      const complete = (): void => {
        if (completed) return;
        completed = true;
        if (cleanupTimer) clearTimeout(cleanupTimer);
        kill(); // also reap same-group descendants after the direct child exits
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        resolveResult(report);
      };
      if (closed) { complete(); return; }
      child.once("close", complete);
      cleanupTimer = setTimeout(complete, 200);
      send({ jsonrpc: "2.0", id: 3, method: "shutdown", params: null });

    };
    const send = (message: Message): void => {
      if (child.stdin.destroyed || child.stdin.writableEnded) return;
      const body = JSON.stringify(message);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    const abort = (): void => finish("LSP: cancelled.");
    const timer = setTimeout(() => finish("LSP: timeout; diagnostics unavailable."), config.timeoutMilliseconds);
    const diagnostics = (items: unknown): void => {
      if (!Array.isArray(items)) { finish("LSP: invalid diagnostics."); return; }
      const lines: string[] = [];
      for (const item of items.slice(0, 20)) {
        const start = item?.range?.start;
        if (!start || !Number.isSafeInteger(start.line) || start.line < 0 || start.line > 1000000 || !Number.isSafeInteger(start.character) || start.character < 0 || start.character > 1000000 || typeof item.message !== "string") continue;
        const severity = ({ 1: "error", 2: "warning", 3: "information", 4: "hint" } as Record<number, string>)[item.severity] ?? "diagnostic";
        lines.push(`${start.line + 1}:${start.character + 1} ${severity}: ${safeLspText(item.message)}`);
      }
      finish(`LSP ${safeLspText(path, 256)}: ${items.length ? `${items.length} reported diagnostic(s)` : "no diagnostics reported"}${lines.length ? `\n${lines.join("\n")}` : ""}${items.length > 20 ? "\n[diagnostics truncated]" : ""}`.slice(0, 8192));
    };
    const receive = (m: Message): void => {
      if (m.jsonrpc !== "2.0") { finish("LSP: protocol error."); return; }
      if (typeof m.method === "string") {
        if (m.id !== undefined) {
          // No server-initiated edits, commands, registrations, configuration or external reads.
          if (typeof m.id !== "number" && (typeof m.id !== "string" || m.id.length > 128)) { finish("LSP: invalid request."); return; }
          send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Client requests disabled" } });
        } else if (opened && !pull && m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri && m.params?.version === 1) diagnostics(m.params.diagnostics);
        return;
      }
      if (m.id === 1 && !opened) {
        if (m.error || !m.result?.capabilities) { finish("LSP: initialization unavailable."); return; }
        pull = Boolean(m.result.capabilities.diagnosticProvider);
        opened = true;
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: config.languageId, version: 1, text } } });
        if (pull) send({ jsonrpc: "2.0", id: 2, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
      } else if (m.id === 2 && opened && pull) {
        if (m.error || m.result?.kind !== "full") finish("LSP: full document diagnostics unavailable.");
        else diagnostics(m.result.items);
      }
    };
    child.on("error", () => finish("LSP: server unavailable."));
    child.stdin.on("error", () => finish("LSP: transport unavailable."));
    child.on("close", () => { closed = true; if (!done) finish("LSP: server exited before diagnostics."); });
    const outputLimit = (): void => {
      outputLimited = true;
      // A report already accepted by finish is immutable, but trailing floods must
      // stop parsing and terminate the process rather than defer to graceful shutdown.
      finish("LSP: output limit exceeded.");
      kill();
    };
    child.stderr.on("data", (chunk: Buffer) => {
      if (completed || outputLimited) return;
      if (chunk.length > TOTAL - total) { total = TOTAL; outputLimit(); return; }
      total += chunk.length;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (completed || outputLimited) return;
      let offset = 0;
      // Retain only the current frame, never concatenate an arbitrary transport chunk.
      while (offset < chunk.length && !completed) {
        if (total === TOTAL) { outputLimit(); return; }
        if (!bodyStart) {
          buffer[used++] = chunk[offset++]!;
          total++;
          if (used < 4 || buffer.readUInt32BE(used - 4) !== 0x0d0a0d0a) {
            if (used >= 8196) { finish("LSP: header limit exceeded."); return; }
            continue;
          }
          const headers = buffer.subarray(0, used - 4).toString("ascii");
          const lengths = [...headers.matchAll(/^Content-Length: ([0-9]+)\r?$/gim)];
          const length = lengths.length === 1 ? Number(lengths[0]![1]) : NaN;
          if (!Number.isSafeInteger(length) || length < 2 || length > FRAME) { finish("LSP: frame limit or protocol error."); return; }
          bodyStart = used; frameEnd = used + length;
        }
        const count = Math.min(frameEnd - used, chunk.length - offset, TOTAL - total);
        chunk.copy(buffer, used, offset, offset + count); used += count; offset += count;
        total += count;
        if (used < frameEnd) continue;
        const body = buffer.subarray(bodyStart, frameEnd);
        used = 0; bodyStart = 0; frameEnd = 0;
        if (++frames > 256) { finish("LSP: message limit exceeded."); return; }
        try { const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error(); if (done) { if (m.id === 3 && !m.method) { send({ jsonrpc: "2.0", method: "exit" }); child.stdin.end(); } } else receive(m); }
        catch { finish("LSP: invalid JSON-RPC message."); }
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: pathToFileURL(root).href, capabilities: { textDocument: { publishDiagnostics: { versionSupport: true }, diagnostic: {} } }, workspaceFolders: [{ uri: pathToFileURL(root).href, name: "workspace" }] } });
  });
}
