import { lstat, mkdir, open, readFile, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const JOURNAL = "activation.json";
const JOURNAL_TEMP = "activation.json.tmp";
const LOCK = ".activation.lock";
const RETIRED = ".activation.retired";

type ActivationState = "preparing" | "pending" | "confirmed";

interface ActivationJournal {
  schemaVersion: 1;
  state: ActivationState;
  retired?: true;
  active: string;
  candidate: string;
  backup: string;
  failed: string;
}

export interface ActivationSlots {
  root: string;
  active: string;
  candidate: string;
  backup: string;
  failed: string;
}

function reject(): never { throw new Error("Unsafe update activation state."); }

function safeName(value: unknown): string {
  if (typeof value !== "string" || !value || value !== basename(value) || value.includes("/") || value.includes("\\") || value === "." || value === ".." || value === JOURNAL || value === JOURNAL_TEMP || value === LOCK || value === RETIRED) reject();
  return value;
}

function parseJournal(text: string): ActivationJournal {
  let input: unknown;
  try { input = JSON.parse(text); } catch { reject(); }
  if (!input || typeof input !== "object" || Array.isArray(input)) reject();
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || (value.state !== "pending" && value.state !== "confirmed" && value.state !== "preparing")) reject();
  if (value.retired !== undefined && value.retired !== true) reject();
  return Object.freeze({
    schemaVersion: 1,
    state: value.state,
    active: safeName(value.active),
    candidate: safeName(value.candidate),
    backup: safeName(value.backup),
    failed: safeName(value.failed),
    ...(value.retired === true ? { retired: true as const } : {}),
  });
}

function slotPaths(slots: ActivationSlots): { root: string; active: string; candidate: string; backup: string; failed: string; journal: string } {
  const root = resolve(slots.root);
  const names = [safeName(slots.active), safeName(slots.candidate), safeName(slots.backup), safeName(slots.failed)];
  if (new Set(names).size !== names.length) reject();
  return Object.freeze({ root, active: join(root, names[0]!), candidate: join(root, names[1]!), backup: join(root, names[2]!), failed: join(root, names[3]!), journal: join(root, JOURNAL) });
}

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function movable(path: string): Promise<void> {
  const state = await lstat(path);
  if (state.isSymbolicLink() || (!state.isFile() && !state.isDirectory())) reject();
}

async function durableJournal(root: string, journal: ActivationJournal): Promise<void> {
  const target = join(root, JOURNAL);
  const temporary = join(root, JOURNAL_TEMP);
  await rm(temporary, { force: true });
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(journal), "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target);
  await syncRoot(root);
}

async function syncRoot(root: string): Promise<void> {
  // Node cannot open directories for fsync on Windows. There we guarantee ordered
  // process-crash recovery, not power-loss durability of directory entries.
  if (process.platform === "win32") return;
  const handle = await open(root, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readJournal(root: string): Promise<ActivationJournal> {
  const path = join(root, JOURNAL);
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink()) reject();
  const journal = parseJournal(await readFile(path, "utf8"));
  slotPaths({ root, ...journal });
  return journal;
}

async function discardRetired(root: string): Promise<void> {
  const retired = join(root, RETIRED);
  if (await present(retired)) {
    await movable(retired);
    await rm(retired, { recursive: true });
    await syncRoot(root);
  }
}

async function withExclusiveLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(root, LOCK);
  try { await mkdir(lock, { mode: 0o700 }); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // PID reuse, clock age and an empty directory cannot establish ownership.
    // Never unlink a possibly live owner's lock, including legacy/crash locks.
    throw new Error("Activation lock ownership is unknown; offline recovery required: stop all updater/host processes, verify the host-owned root, remove only the empty .activation.lock directory, then retry recovery.");
  }
  try { return await operation(); }
  finally { await rmdir(lock).catch(() => {}); }
}

/**
 * Switches only host-owned prepared slots. It never executes a candidate or opens user data.
 * A caller must confirm only after a separately launched candidate has passed its health check.
 */
export async function activateStagedCandidate(slots: ActivationSlots): Promise<void> {
  const paths = slotPaths(slots);
  const rootState = await lstat(paths.root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) reject();
  await withExclusiveLock(paths.root, async () => {
    if (await present(paths.failed)) reject();
    await movable(paths.active);
    await movable(paths.candidate);
    let journal: ActivationJournal = Object.freeze({ schemaVersion: 1, state: "pending", active: slots.active, candidate: slots.candidate, backup: slots.backup, failed: slots.failed });
    if (await present(paths.journal)) {
      const prior = await readJournal(paths.root);
      if (prior.state !== "confirmed" || prior.active !== slots.active || prior.candidate !== slots.candidate || prior.backup !== slots.backup || prior.failed !== slots.failed) reject();
      await movable(paths.backup);
      // An older generation may be retired only while BOTH confirmed slots exist.
      if (prior.retired) await discardRetired(paths.root);
      else if (await present(join(paths.root, RETIRED))) reject();
      journal = Object.freeze({ ...journal, retired: true });
      await durableJournal(paths.root, { ...journal, state: "preparing" });
      await rename(paths.backup, join(paths.root, RETIRED));
      await syncRoot(paths.root);
    } else if (await present(paths.backup) || await present(join(paths.root, RETIRED))) reject();
    await durableJournal(paths.root, journal);
    // Leave the journal authoritative on failure; recovery is resumable at each rename.
    await rename(paths.active, paths.backup);
    await syncRoot(paths.root);
    await rename(paths.candidate, paths.active);
    await syncRoot(paths.root);
  });
}

/** Restores the old slot unless the candidate has durably acknowledged health. */
export async function recoverUnconfirmedActivation(rootInput: string): Promise<"none" | "confirmed" | "rolled-back"> {
  const root = resolve(rootInput);
  const journalPath = join(root, JOURNAL);
  if (!(await present(journalPath))) return "none";
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) reject();
  return withExclusiveLock(root, async () => {
    if (!(await present(journalPath))) return "none";
    const journal = await readJournal(root);
    const paths = slotPaths({ root, ...journal });
    const retired = join(root, RETIRED);
    if (!journal.retired && await present(retired)) reject();
    if (journal.state === "confirmed") {
      await movable(paths.active);
      await movable(paths.backup);
      return "confirmed";
    }
    if (journal.state === "preparing") {
      await movable(paths.active);
      if (await present(paths.candidate)) await movable(paths.candidate);
      if (await present(paths.failed)) reject();
      if (await present(retired)) {
        if (await present(paths.backup)) reject();
        await movable(retired);
        await rename(retired, paths.backup);
        await syncRoot(root);
      }
      await movable(paths.backup);
      await durableJournal(root, { ...journal, state: "confirmed" });
      return "confirmed";
    }
    if (!(await present(paths.backup))) {
      // Before moving active, or after restoring it but before removing intent.
      if (await present(paths.active) && (await present(paths.candidate) !== await present(paths.failed))) {
        await movable(paths.active);
        await movable(await present(paths.candidate) ? paths.candidate : paths.failed);
        if (await present(paths.candidate) && await present(retired)) {
          // No switch happened. Restore the prior confirmed transaction through
          // preparing so an interruption cannot reinterpret the old backup as new.
          await movable(retired);
          await durableJournal(root, { ...journal, state: "preparing" });
          await rename(retired, paths.backup);
          await syncRoot(root);
          await durableJournal(root, { ...journal, state: "confirmed" });
        } else {
          await unlink(paths.journal);
          await syncRoot(root);
        }
        return "rolled-back";
      }
      reject();
    }
    await movable(paths.backup);
    // These combinations cannot be produced by the transaction: never overwrite evidence.
    if (await present(paths.active) && await present(paths.candidate)) reject();
    if (await present(paths.candidate) && await present(paths.failed)) reject();
    if (await present(paths.active)) {
      if (await present(paths.failed)) reject();
      await movable(paths.active);
      await rename(paths.active, paths.failed);
      await syncRoot(root);
    }
    if (await present(paths.candidate)) {
      await movable(paths.candidate);
      await rename(paths.candidate, paths.failed);
      await syncRoot(root);
    }
    if (await present(paths.failed)) {
      await movable(paths.failed);
    } else reject();
    await rename(paths.backup, paths.active);
    await syncRoot(root);
    await unlink(paths.journal);
    await syncRoot(root);
    return "rolled-back";
  });
}

/** Marks a candidate healthy; previous bytes remain available for an explicit later rollback policy. */
export async function confirmActivatedUpdate(rootInput: string): Promise<void> {
  const root = resolve(rootInput);
  const journalPath = join(root, JOURNAL);
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) reject();
  await withExclusiveLock(root, async () => {
    const journalState = await lstat(journalPath);
    if (!journalState.isFile() || journalState.isSymbolicLink()) reject();
    const journal = parseJournal(await readFile(journalPath, "utf8"));
    if (journal.state !== "pending") reject();
    const paths = slotPaths({ root, ...journal });
    if (!(await present(paths.active)) || !(await present(paths.backup)) || await present(paths.candidate)) reject();
    await movable(paths.active);
    await movable(paths.backup);
    await durableJournal(root, Object.freeze({ ...journal, state: "confirmed" }));
    if (journal.retired) await discardRetired(root);
  });
}
