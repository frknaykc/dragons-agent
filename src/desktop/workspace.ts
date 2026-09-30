import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** A launcher may explicitly select one workspace; renderer messages and env vars never do. */
export function parseTrustedDesktopWorkspaceArg(args: readonly string[]): string | undefined {
  const values = args.filter((arg) => arg === "--workspace" || arg.startsWith("--workspace="));
  if (values.length > 1) throw new Error("Specify only one Desktop workspace.");
  if (values.length === 0) return undefined;
  const selected = values[0]!.slice("--workspace=".length);
  if (!isAbsolute(selected)) throw new Error("Desktop workspace argument must be absolute.");
  return selected;
}

/** Packaged launches require an explicit trusted launcher path or native selection. */
export async function selectDesktopWorkspace(options: {
  packaged: boolean;
  workingDirectory: string;
  trustedWorkspace?: string;
  selectDirectory: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  if (options.trustedWorkspace !== undefined && !isAbsolute(options.trustedWorkspace)) throw new Error("Desktop trusted workspace must be absolute.");
  const candidate = options.packaged ? options.trustedWorkspace ?? await options.selectDirectory() : options.workingDirectory;
  if (candidate === undefined) return undefined;
  const directory = await realpath(candidate);
  if (!(await stat(directory)).isDirectory()) throw new Error("Desktop workspace must be a directory.");
  return directory;
}
