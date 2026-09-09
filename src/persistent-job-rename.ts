import { setTimeout } from "node:timers/promises";

/** Preserve atomic replacement while allowing bounded Windows sharing-conflict recovery. */
export async function retryPersistentJobRename<T>(
  save: () => Promise<T>,
  dependencies: {
    platform?: NodeJS.Platform;
    delay?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  const delay = dependencies.delay ?? ((milliseconds: number) => setTimeout(milliseconds));
  const platform = dependencies.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await save();
    } catch (error: unknown) {
      // Windows can reject replacement while another reader holds the destination.
      // Never unlink the destination or relax permissions; persistent errors still fail.
      const failure = error as NodeJS.ErrnoException;
      if (platform !== "win32" || failure?.code !== "EPERM" || failure.syscall !== "rename" || attempt >= 5) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}
