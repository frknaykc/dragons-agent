import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { stageMacOSBundleForValidation, type MacOSValidationDependencies } from "./update-macos.js";
import { createMacOSPreflight, type MacOSPreflightDependencies } from "./update-macos-preflight.js";
import { fetchAndStageTrustedUpdate, fetchTrustedUpdateManifest, type TrustedUpdateSource } from "./update-transport.js";
import { productionUpdatePolicy, type UpdatePolicy } from "./update.js";

export type DesktopUpdateState = "preparing" | "prepared" | "disabled" | "idle" | "checking" | "available" | "unavailable" | "cancelled" | "closed";
export interface DesktopUpdateStatus {
  state: DesktopUpdateState;
  canCheck: boolean;
  canPrepare: boolean;
  canCancel: boolean;
  canInstall: false;
  version?: string;
}
/** Trusted composition only. Never populate from IPC, model output, workspace or environment. */
export interface DesktopUpdateConfiguration {
  source: TrustedUpdateSource;
  policy: UpdatePolicy;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  macOS?: {
    /** Existing private host-owned root outside workspaces and installed apps. */
    root: string;
    target: string;
    identity: { teamIdentifier: string; bundleIdentifier: string };
    validationDependencies?: MacOSValidationDependencies;
    preflightDependencies?: MacOSPreflightDependencies;
  };
}

/** Host-owned preparation only. No paths or activation capability leave this class. */
export class DesktopUpdateController {
  #state: DesktopUpdateState;
  #version?: string;
  // Only paths created by this instance are eligible for cleanup.
  #owned = new Set<string>();
  #cleanupFailed = false;
  #closing?: Promise<void>;
  #active?: { controller: AbortController; done: Promise<void> };
  #configuration?: DesktopUpdateConfiguration;
  constructor(configuration?: DesktopUpdateConfiguration, private readonly remove: typeof rm = rm) {
    this.#state = productionUpdatePolicy.enabled ? "unavailable" : "disabled";
    if (configuration) {
      const timeoutMs = configuration.timeoutMs ?? 15_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid update check deadline.");
      this.#configuration = { ...configuration, timeoutMs, source: { ...configuration.source }, policy: { ...configuration.policy, trustedKeys: new Map(configuration.policy.trustedKeys) } };
      if (configuration.macOS) this.#configuration.macOS = {
        ...configuration.macOS, identity: { ...configuration.macOS.identity },
        ...(configuration.macOS.validationDependencies ? { validationDependencies: { ...configuration.macOS.validationDependencies } } : {}),
        ...(configuration.macOS.preflightDependencies ? { preflightDependencies: { ...configuration.macOS.preflightDependencies } } : {}),
      };
      this.#state = "idle";
    }
  }
  status(): DesktopUpdateStatus {
    return { state: this.#state, canCheck: !!this.#configuration && !this.#active && this.#state !== "closed", canPrepare: !!this.#configuration?.macOS && !this.#active && this.#state !== "closed", canCancel: this.#state === "checking" || this.#state === "preparing", canInstall: false, ...(this.#version ? { version: this.#version } : {}) };
  }
  prepare(): DesktopUpdateStatus {
    if (!this.#configuration?.macOS) return this.status();
    return this.#start(true);
  }
  check(): DesktopUpdateStatus { return this.#start(false); }
  #start(prepare: boolean): DesktopUpdateStatus {
    if (!this.status().canCheck) return this.status();
    const configuration = this.#configuration!;
    const controller = new AbortController();
    this.#state = prepare ? "preparing" : "checking"; this.#version = undefined;
    const active = { controller, done: Promise.resolve() };
    this.#active = active;
    const timer = setTimeout(() => controller.abort(), configuration.timeoutMs);
    active.done = Promise.resolve().then(async () => {
      let temporary: string | undefined;
      try {
        await this.#discard();
        controller.signal.throwIfAborted();
        if (prepare) {
          const mac = configuration.macOS!;
          const preflight = createMacOSPreflight(mac.identity, mac.preflightDependencies);
          const state = await lstat(mac.root);
          if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) throw new Error("Unsafe staging root.");
          temporary = await mkdtemp(join(mac.root, "desktop-prepare-"));
          this.#owned.add(temporary);
          const result = await fetchAndStageTrustedUpdate({ ...configuration, root: temporary, signal: controller.signal });
          const candidate = await stageMacOSBundleForValidation({ stage: result.directory, root: temporary, policy: configuration.policy, signal: controller.signal }, mac.validationDependencies);
          await preflight.verifySignature(candidate.bundle, controller.signal);
          await preflight.inspectInstallTarget(mac.target, candidate.directory, controller.signal);
          controller.signal.throwIfAborted();
          if (this.#state === "preparing") {
            temporary = undefined;
            this.#version = result.manifest.version; this.#state = "prepared";
          }
        } else {
          const result = await fetchTrustedUpdateManifest({ ...configuration, signal: controller.signal });
          if (this.#state === "checking" && !controller.signal.aborted) {
            this.#version = result.manifest.version; this.#state = "available";
          }
        }
      } catch { if (this.#state === "checking" || this.#state === "preparing") this.#state = "unavailable"; }
      finally {
        try { if (temporary) await this.#removeOwned(temporary); }
        finally {
          clearTimeout(timer);
          if (this.#state === "checking" || this.#state === "preparing") this.#state = "unavailable";
          if (this.#active === active) this.#active = undefined;
        }
      }
    });
    // Ownership and sanitized failure accounting survive active.done settling.
    void active.done.catch(() => {});
    return this.status();
  }
  cancel(): DesktopUpdateStatus {
    if (this.#state === "checking" || this.#state === "preparing") { this.#state = "cancelled"; this.#active?.controller.abort(); }
    return this.status();
  }
  close(): Promise<void> {
    this.#state = "closed"; this.#version = undefined;
    this.#active?.controller.abort();
    return this.#closing ??= Promise.resolve().then(async () => {
      try { await this.#active?.done; } catch { this.#cleanupFailed = true; }
      try { await this.#discard(); } catch { this.#cleanupFailed = true; }
      if (this.#cleanupFailed) throw new Error("Desktop update cleanup failed.");
    });
  }
  async #discard(): Promise<void> {
    let failed = false;
    for (const path of this.#owned) {
      try { await this.#removeOwned(path); } catch { failed = true; }
    }
    if (failed) throw new Error("Desktop update cleanup failed.");
  }
  async #removeOwned(path: string): Promise<void> {
    try {
      await this.remove(path, { recursive: true, force: true });
      this.#owned.delete(path);
    } catch {
      this.#cleanupFailed = true;
      throw new Error("Desktop update cleanup failed.");
    }
  }
}
