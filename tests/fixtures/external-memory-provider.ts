import type { ExternalMemoryProvider, ExternalMemoryRecord } from "../../dist/external-memory.js";
import type { MemoryScope } from "../../dist/memory.js";

function scopeKey(scope: MemoryScope): string {
  return scope.kind === "USER" ? "USER" : `PROJECT:${scope.workspaceId}`;
}
function copy(record: ExternalMemoryRecord): ExternalMemoryRecord {
  return { ...record, scope: { ...record.scope } as MemoryScope };
}

/** Deterministic, network-free contract fixture. No credentials, automatic sharing or service calls. */
export class FakeExternalMemoryProvider implements ExternalMemoryProvider {
  readonly id = "fake-memory";
  readonly calls: string[] = [];
  private readonly records = new Map<string, ExternalMemoryRecord>();
  constructor(private readonly now: () => Date) {}

  private purgeExpired(): void {
    for (const [key, record] of this.records) {
      if (Date.parse(record.expiresAt) <= this.now().getTime()) this.records.delete(key);
    }
  }

  async list(scope: MemoryScope, signal?: AbortSignal): Promise<ExternalMemoryRecord[]> {
    signal?.throwIfAborted();
    this.purgeExpired();
    this.calls.push(`list:${scopeKey(scope)}`);
    return [...this.records.values()].filter((record) => scopeKey(record.scope) === scopeKey(scope))
      .map(copy).sort((a, b) => a.id.localeCompare(b.id));
  }
  async upsert(record: ExternalMemoryRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.purgeExpired();
    this.calls.push(`upsert:${scopeKey(record.scope)}:${record.id}`);
    this.records.set(`${scopeKey(record.scope)}:${record.id}`, copy(record));
  }
  async remove(id: string, scope: MemoryScope, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    this.purgeExpired();
    this.calls.push(`remove:${scopeKey(scope)}:${id}`);
    return this.records.delete(`${scopeKey(scope)}:${id}`);
  }
}
