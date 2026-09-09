import { realpath, stat } from "node:fs/promises";

/** Packaged launches require explicit selection in the trusted main process. */
export async function selectDesktopWorkspace(options: {
  packaged: boolean;
  workingDirectory: string;
  selectDirectory: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  const candidate = options.packaged ? await options.selectDirectory() : options.workingDirectory;
  if (candidate === undefined) return undefined;
  const directory = await realpath(candidate);
  if (!(await stat(directory)).isDirectory()) throw new Error("Desktop workspace must be a directory.");
  return directory;
}
