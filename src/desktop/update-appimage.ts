import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, open, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { activationMode, verifyUpdateManifest, type UpdatePolicy } from "./update.js";
import { runIsolatedHealthProbe } from "./update-health-worker.js";
import { activateStagedCandidate, confirmActivatedUpdate, recoverUnconfirmedActivation, type ActivationSlots } from "./update-transaction.js";

function reject(): never { throw new Error("Unsafe AppImage update activation."); }

function slotName(value: string): string {
  if (!value || value !== basename(value) || value.includes("/") || value.includes("\\") || value === "." || value === ".." || ["activation.json", "activation.json.tmp", ".activation.lock", ".activation.retired"].includes(value)) reject();
  return value;
}

async function verifyStagedArtifact(stageInput: string, policy: UpdatePolicy, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const stage = resolve(stageInput);
  const stageState = await lstat(stage);
  if (!stageState.isDirectory() || stageState.isSymbolicLink()) reject();
  const artifact = join(stage, "artifact");
  const receipt = join(stage, "manifest.json");
  const artifactState = await lstat(artifact);
  const receiptState = await lstat(receipt);
  if (!artifactState.isFile() || artifactState.isSymbolicLink() || !receiptState.isFile() || receiptState.isSymbolicLink()) reject();
  const manifest = verifyUpdateManifest(await readFile(receipt, { encoding: "utf8", signal }), policy);
  if (activationMode(manifest) !== "transactional" || manifest.platform !== "linux" || !manifest.artifact.toLowerCase().endsWith(".appimage") || artifactState.size !== manifest.size) reject();
  const hash = createHash("sha256");
  const handle = await open(artifact, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  signal?.throwIfAborted();
  if (hash.digest("hex") !== manifest.sha256) reject();
  return artifact;
}

export interface AppImageActivationOptions extends ActivationSlots {
  stage: string;
  policy: UpdatePolicy;
  sourceEnvironment: NodeJS.ProcessEnv;
  timeoutMilliseconds: number;
  signal?: AbortSignal;
}

/**
 * Runs only after the current AppImage has exited. macOS ZIP and Windows EXE formats
 * require their own installer adapters; DEB is intentionally not accepted here.
 */
export async function activateVerifiedAppImage(options: AppImageActivationOptions): Promise<void> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 1 || options.timeoutMilliseconds > 60_000) reject();
  const artifact = await verifyStagedArtifact(options.stage, options.policy, options.signal);
  const root = resolve(options.root);
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) reject();
  const names = [slotName(options.active), slotName(options.candidate), slotName(options.backup), slotName(options.failed)];
  if (new Set(names).size !== names.length) reject();
  const candidate = join(root, names[1]!);
  options.signal?.throwIfAborted();
  // Once copied, retain the candidate on every failure: a pre-existing journal
  // may already reference this path, even before this invocation enters activation.
  await copyFile(artifact, candidate, constants.COPYFILE_EXCL);
  await chmod(candidate, 0o700);
  options.signal?.throwIfAborted();
  // From here the transaction may own the candidate, even if activation rejects.
  // Never delete it or guess whether a preparing/pending/unknown journal is ours.
  // Preserve evidence for explicit recovery, including failures before the switch.
  await activateStagedCandidate(options);
  try {
    options.signal?.throwIfAborted();
    await runIsolatedHealthProbe({ executable: join(root, options.active), root, sourceEnvironment: options.sourceEnvironment, timeoutMilliseconds: options.timeoutMilliseconds, ...(options.signal ? { signal: options.signal } : {}) });
    options.signal?.throwIfAborted();
    await confirmActivatedUpdate(root);
  } catch (error) {
    try {
      // Recovery is deliberately not cancelled. The health worker rejects only
      // after its child exits, so rollback cannot race a still-running probe.
      if (await recoverUnconfirmedActivation(root) !== "rolled-back") throw new Error("Unexpected update recovery state.");
    } catch {
      throw new Error("Update activation recovery failed.");
    }
    throw error;
  }
}
