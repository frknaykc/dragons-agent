import { rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

/** Preserve atomic replacement while allowing bounded Windows sharing-conflict recovery. */
export async function renamePersistentJob(
  source: string,
  target: string,
  dependencies: {
    platform?: NodeJS.Platform;
    rename?: typeof rename;
    delay?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const replace = dependencies.rename ?? rename;
  const delay = dependencies.delay ?? ((milliseconds: number) => setTimeout(milliseconds));
  const platform = dependencies.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await replace(source, target);
      return;
    } catch (error: unknown) {
      // Windows can reject replacement while another reader holds the destination.
      // Never unlink the destination or relax permissions; persistent errors still fail.
      if (platform !== "win32" || (error as NodeJS.ErrnoException)?.code !== "EPERM" || attempt >= 5) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}
