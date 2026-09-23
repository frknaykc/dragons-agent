import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { activateStagedCandidate, confirmActivatedUpdate, recoverUnconfirmedActivation } from "./update-transaction.js";

// Laboratory coordinator only. No installed-app path, native host-exit claim,
// helper bootstrap, renderer IPC or production activation capability is exposed.
export const macOSLifecycleSupport = Object.freeze({ production: false, scope: "disposable-directory-laboratory" });
type State = "prepared" | "activating" | "pending" | "confirming" | "healthy" | "data-released" | "rolling-back" | "rolled-back";
const states: readonly State[] = ["prepared", "activating", "pending", "confirming", "healthy", "data-released", "rolling-back", "rolled-back"];
const JOURNAL = "macos-lifecycle.json";
const LOCK = ".macos-lifecycle-owner";
const DOMAIN = "dragons:macos-disposable-lifecycle:v1\n";
interface RecordState { schema: 1; scope: "disposable"; root: string; id: string; state: State }
export interface MacOSHostHandoff { readonly payload: string; readonly mac: string }
function fail(): never { throw new Error("Unsafe macOS lifecycle state or handoff; offline recovery required."); }
function keyCopy(key: Uint8Array): Buffer { if (key.byteLength !== 32) fail(); return Buffer.from(key); }
function seal(record: RecordState, key: Buffer): MacOSHostHandoff {
  const payload = JSON.stringify(record);
  return Object.freeze({ payload, mac: createHmac("sha256", key).update(DOMAIN).update(payload).digest("hex") });
}
function authenticate(input: unknown, key: Buffer, root: string): RecordState {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== "mac,payload" || typeof value.payload !== "string" || value.payload.length > 4096 || typeof value.mac !== "string" || !/^[a-f0-9]{64}$/.test(value.mac)) fail();
  const expected = createHmac("sha256", key).update(DOMAIN).update(value.payload).digest();
  if (!timingSafeEqual(expected, Buffer.from(value.mac, "hex"))) fail();
  const record = JSON.parse(value.payload) as RecordState;
  if (!record || Object.keys(record).sort().join() !== "id,root,schema,scope,state" || record.schema !== 1 || record.scope !== "disposable" || record.root !== root || !/^[a-f0-9]{64}$/.test(record.id) || !states.includes(record.state)) fail();
  return record;
}
async function syncDirectory(root: string): Promise<void> {
  const handle = await open(root, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateRoot(root: string): Promise<void> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail();
}
async function readState(root: string, key: Buffer): Promise<RecordState> {
  const path = join(root, JOURNAL);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192 || (stat.mode & 0o077) !== 0) fail();
  return authenticate(JSON.parse(await readFile(path, "utf8")), key, root);
}
async function persist(record: RecordState, key: Buffer): Promise<void> {
  const temporary = join(record.root, `${JOURNAL}.${randomBytes(16).toString("hex")}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(seal(record, key))); await file.sync(); } finally { await file.close(); }
  await rename(temporary, join(record.root, JOURNAL));
  await syncDirectory(record.root);
}

/** Host-only authentication key must arrive through a private host channel, never
 * the journal, renderer, argv or environment. HMAC is not OS peer authentication.
 * Same-account/root compromise and journal snapshot replay are outside this lab.
 * Ownership persists across ALL phases, errors and crashes. No PID/age takeover
 * or automatic lock deletion. Offline recovery requires stopping every owner
 * and explicitly removing only the empty owner directory (and transaction lock).
 */
export class DisposableMacOSLifecycle {
  readonly root: string;
  #record: RecordState;
  #key: Buffer;
  #busy = false;
  #poisoned = false;
  #owner: { ino: number; dev: number };
  private constructor(record: RecordState, key: Buffer, owner: { ino: number; dev: number }) { this.root = record.root; this.#record = record; this.#key = key; this.#owner = owner; }

  static async create(hostKey: Uint8Array): Promise<DisposableMacOSLifecycle> {
    if (process.platform === "win32") throw new Error("Directory durability unsupported in this macOS laboratory.");
    const key = keyCopy(hostKey);
    // Caller cannot nominate an installed app/root. Only newly created temp slots.
    const root = await mkdtemp(join(tmpdir(), "dragons-macos-lifecycle-"));
    await privateRoot(root);
    await mkdir(join(root, LOCK), { mode: 0o700 });
    const record: RecordState = { schema: 1, scope: "disposable", root, id: randomBytes(32).toString("hex"), state: "prepared" };
    await persist(record, key);
    return new DisposableMacOSLifecycle(record, key, await lstat(join(root, LOCK)));
  }

  /** Resume only after explicit offline ownership recovery. Authenticates the
   * host's original handoff AND current durable state; never trusts supplied state. */
  static async resume(rootInput: string, hostKey: Uint8Array, handoff: MacOSHostHandoff): Promise<DisposableMacOSLifecycle> {
    const root = resolve(rootInput), key = keyCopy(hostKey);
    await privateRoot(root);
    const contract = authenticate(handoff, key, root);
    if (contract.state !== "prepared") fail();
    // Acquire before reading state; lock remains even on corrupt journal.
    await mkdir(join(root, LOCK), { mode: 0o700 });
    await syncDirectory(root);
    const record = await readState(root, key);
    if (record.id !== contract.id) fail();
    return new DisposableMacOSLifecycle(record, key, await lstat(join(root, LOCK)));
  }

  handoff(): MacOSHostHandoff { return seal({ ...this.#record, state: "prepared" }, this.#key); }
  get state(): State { return this.#record.state; }
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy || this.#poisoned) fail();
    this.#busy = true;
    try {
      const owner = await lstat(join(this.root, LOCK));
      if (!owner.isDirectory() || owner.isSymbolicLink() || owner.ino !== this.#owner.ino || owner.dev !== this.#owner.dev) fail();
      const current = await readState(this.root, this.#key);
      if (JSON.stringify(current) !== JSON.stringify(this.#record)) fail();
      return await operation();
    }
    catch (error) { this.#poisoned = true; throw error; }
    finally { this.#busy = false; }
  }
  async #transition(state: State): Promise<void> {
    const record = { ...this.#record, state };
    await persist(record, this.#key);
    this.#record = record;
  }

  /** Exercises the existing real directory transaction in disposable slots only.
   * Not native activation: there is no host process to stop or app to relaunch. */
  async activatePreparedDirectories(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.state !== "prepared") fail();
      for (const name of ["active.app", "candidate.app"]) {
        const stat = await lstat(join(this.root, name));
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
      }
      await this.#transition("activating");
      await activateStagedCandidate({ root: this.root, active: "active.app", candidate: "candidate.app", backup: "previous.app", failed: "failed.app" });
      await this.#transition("pending");
    });
  }

  /** Trusted host probe adapter, not a boolean/renderer verdict. In this lab the
   * adapter is responsible for isolation and child-exit completion on failure. */
  async probeAndConfirm(probe: (bundle: string) => Promise<void>): Promise<void> {
    return this.#exclusive(async () => {
      if (this.state !== "pending") fail();
      await probe(join(this.root, "active.app"));
      await this.#transition("confirming");
      await confirmActivatedUpdate(this.root);
      await this.#transition("healthy");
    });
  }

  /** Durable, irrevocable barrier precedes any host data-release side effect.
   * A thrown callback or crash is NOT evidence that data remained untouched.
   * The lock remains: next update/relaunch needs native lifetime ownership. */
  async releaseDataAccess(release: () => Promise<void>): Promise<void> {
    return this.#exclusive(async () => {
      if (this.state !== "healthy") fail();
      await this.#transition("data-released");
      await release();
    });
  }

  async recoverBeforeDataRelease(): Promise<"rolled-back" | "preserved"> {
    return this.#exclusive(async () => {
      if (this.state === "data-released") throw new Error("Data access was released; automatic rollback/relaunch forbidden.");
      // Confirming can mean binary confirmation completed before journal update.
      // Never reinterpret that ambiguity as permission to run an older binary.
      if (this.state === "healthy" || this.state === "confirming") return "preserved";
      if (this.state === "rolled-back") return "rolled-back";
      await this.#transition("rolling-back");
      const outcome = await recoverUnconfirmedActivation(this.root);
      if (outcome === "confirmed") fail();
      await this.#transition("rolled-back");
      return "rolled-back";
    });
  }
}
