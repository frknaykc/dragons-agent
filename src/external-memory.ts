import { createHash } from "node:crypto";

import { DEFAULT_MAX_MEMORY_BODY_CHARS, type DragonsMemory, type MemoryScope, type MemoryStore } from "./memory.js";

const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_ID = /^[a-f0-9]{64}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const DAY = 86_400_000;

/** Data contract only. A trusted host supplies an adapter; Dragons ships no network adapter or credentials. */
export type ExternalMemoryRecord = {
  id: string;
  body: string;
  scope: MemoryScope;
  expiresAt: string;
};

export type ExternalMemoryProvider = {
  readonly id: string;
  list(scope: MemoryScope, signal?: AbortSignal): Promise<ExternalMemoryRecord[]>;
  upsert(record: ExternalMemoryRecord, signal?: AbortSignal): Promise<void>;
  remove(id: string, scope: MemoryScope, signal?: AbortSignal): Promise<boolean>;
};

export type ExternalMemoryApproval = {
  action: "share" | "remove";
  providerId: string;
  record: ExternalMemoryRecord;
};

export type ExternalMemoryTransfer = {
  store: MemoryStore;
  provider: ExternalMemoryProvider;
  scope: MemoryScope;
  id: string;
  /** Must be a fresh, explicit decision about the exact record and destination. */
  approve(request: ExternalMemoryApproval): boolean | Promise<boolean>;
  signal?: AbortSignal;
};

function copyScope(scope: MemoryScope): MemoryScope {
  if (!scope || typeof scope !== "object" || (scope.kind !== "USER" && scope.kind !== "PROJECT")) throw new Error("Invalid memory scope.");
  if (scope.kind === "USER") {
    if (Object.keys(scope).some((key) => key !== "kind")) throw new Error("Invalid memory scope.");
    return { kind: "USER" };
  }
  if (Object.keys(scope).some((key) => key !== "kind" && key !== "workspaceId") || typeof scope.workspaceId !== "string" || !WORKSPACE_ID.test(scope.workspaceId)) throw new Error("Invalid memory scope.");
  return { kind: "PROJECT", workspaceId: scope.workspaceId };
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.kind === right.kind && (left.kind === "USER" || left.workspaceId === (right as Extract<MemoryScope, { kind: "PROJECT" }>).workspaceId);
}

function checkId(id: string): void {
  if (typeof id !== "string" || !MEMORY_ID.test(id)) throw new Error("Invalid memory ID.");
}

function checkProvider(provider: ExternalMemoryProvider): void {
  if (!provider || typeof provider.id !== "string" || !PROVIDER_ID.test(provider.id) || typeof provider.upsert !== "function" || typeof provider.remove !== "function" || typeof provider.list !== "function") throw new Error("Invalid external memory provider.");
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("External memory transfer cancelled.");
}

function secretLike(body: string): boolean {
  return /(?:^|[^A-Za-z0-9_])[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)[A-Za-z0-9_]*\s*[:=]\s*\S+/i.test(body)
    || /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/.test(body)
    || /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/i.test(body);
}

function checkedRecord(value: ExternalMemoryRecord, now: number, allowExpired = false): ExternalMemoryRecord {
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => !["id", "body", "scope", "expiresAt"].includes(key))) throw new Error("Invalid external memory record.");
  checkId(value.id);
  if (typeof value.body !== "string" || !value.body.trim() || value.body.length > DEFAULT_MAX_MEMORY_BODY_CHARS || secretLike(value.body)) throw new Error("External memory body is invalid or appears to contain a secret.");
  const scope = copyScope(value.scope);
  const expiry = Date.parse(value.expiresAt);
  if (typeof value.expiresAt !== "string" || !Number.isFinite(expiry) || (!allowExpired && expiry <= now) || expiry > now + 365 * DAY) throw new Error("External memory retention is invalid.");
  return { id: value.id, body: value.body, scope, expiresAt: new Date(expiry).toISOString() };
}

function checkedTransfer(input: ExternalMemoryTransfer): MemoryScope {
  if (!input || typeof input.store?.get !== "function" || typeof input.provider !== "object" || typeof input.approve !== "function") throw new Error("Invalid external memory transfer.");
  checkProvider(input.provider);
  checkId(input.id);
  return copyScope(input.scope);
}

function fingerprint(memory: DragonsMemory): string {
  return createHash("sha256").update(JSON.stringify([memory.id, memory.body, memory.scope, memory.expiresAt])).digest("hex");
}

/** Manual, one-record push. Approval is not an AgentTool and is never inferred from model text or stored. */
export async function shareMemoryWithProvider(input: ExternalMemoryTransfer & { retentionDays: number; now?: () => Date }): Promise<boolean> {
  const scope = checkedTransfer(input);
  if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 365) throw new Error("External memory retention must be 1–365 days.");
  checkSignal(input.signal);
  const current = await input.store.get(input.id, scope);
  checkSignal(input.signal);
  if (!current || !sameScope(scope, current.scope)) return false;
  if (current.id !== input.id) throw new Error("Memory ID changed during external sharing.");
  const instant = input.now?.().getTime() ?? Date.now();
  if (!Number.isFinite(instant)) throw new Error("Invalid clock.");
  const localExpiry = current.expiresAt === undefined ? Infinity : Date.parse(current.expiresAt);
  if (Number.isNaN(localExpiry)) throw new Error("Invalid local memory expiry.");
  const expiresAt = new Date(Math.min(instant + input.retentionDays * DAY, localExpiry)).toISOString();
  const record = checkedRecord({ id: current.id, body: current.body, scope, expiresAt }, instant);
  const before = fingerprint(current);
  if (await input.approve({ action: "share", providerId: input.provider.id, record: { ...record, scope: copyScope(record.scope) } }) !== true) return false;
  checkSignal(input.signal);
  const latest = await input.store.get(input.id, scope);
  if (!latest || !sameScope(scope, latest.scope) || fingerprint(latest) !== before) throw new Error("Memory changed since external sharing was approved.");
  // Recheck expiry after an asynchronous decision; remote retention never outlives local expiry.
  const after = input.now?.().getTime() ?? Date.now();
  if (after >= Date.parse(record.expiresAt)) throw new Error("Approved external memory has expired.");
  checkSignal(input.signal);
  await input.provider.upsert({ ...record, scope: copyScope(record.scope) }, input.signal);
  return true;
}

/** Manual remote removal; local memory is untouched. No automatic bidirectional sync or imports. */
export async function removeMemoryFromProvider(input: ExternalMemoryTransfer & { now?: () => Date }): Promise<boolean> {
  const scope = checkedTransfer(input);
  checkSignal(input.signal);
  const instant = input.now?.().getTime() ?? Date.now();
  if (!Number.isFinite(instant)) throw new Error("Invalid clock.");
  const records = await input.provider.list(scope, input.signal);
  checkSignal(input.signal);
  if (!Array.isArray(records) || records.length > 100) throw new Error("External memory listing exceeds the limit.");
  const found = records.find((record) => record?.id === input.id);
  if (!found) return false;
  const record = checkedRecord(found, instant, true);
  if (!sameScope(scope, record.scope)) throw new Error("External memory scope mismatch.");
  if (await input.approve({ action: "remove", providerId: input.provider.id, record: { ...record, scope: copyScope(record.scope) } }) !== true) return false;
  checkSignal(input.signal);
  const latest = await input.provider.list(scope, input.signal);
  checkSignal(input.signal);
  if (!Array.isArray(latest) || latest.length > 100) throw new Error("External memory listing exceeds the limit.");
  const matching = latest.find((candidate) => candidate?.id === input.id);
  if (!matching || JSON.stringify(checkedRecord(matching, instant, true)) !== JSON.stringify(record)) throw new Error("External memory changed since removal was approved.");
  checkSignal(input.signal);
  return input.provider.remove(input.id, scope, input.signal);
}
