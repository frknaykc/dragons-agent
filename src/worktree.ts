import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
// Git for Windows cannot use Node's \\.\nul device path as a Git config path.
const gitNull = process.platform === "win32" ? "NUL" : devNull;
const safe = ["--no-optional-locks", "-c", `core.hooksPath=${gitNull}`, "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "protocol.allow=never"];
const ignoredEnv = /^(GIT_|GIT_CONFIG|SSH_)/;
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !ignoredEnv.test(key))), GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitNull });

async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await exec("git", [...safe, ...args], { cwd: root, env: env(), encoding: "utf8", maxBuffer: 256_000, timeout: 30_000, signal });
  return stdout;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validateName(name: string): void {
  if (!namePattern.test(name)) throw new Error("Worktree name must be 1–63 ASCII letters, digits, underscores or hyphens, starting with a letter or digit.");
}

async function rootOf(workspace: string, signal?: AbortSignal): Promise<string> {
  const root = await realpath(workspace);
  if (!samePath(await realpath((await git(root, ["rev-parse", "--show-toplevel"], signal)).trim()), root)) throw new Error("Workspace must be the Git repository root.");
  const listing = await git(root, ["worktree", "list", "--porcelain", "-z"], signal);
  const main = listing.split("\0").find((line) => line.startsWith("worktree "))?.slice(9);
  if (!main || !samePath(await realpath(main), main)) throw new Error("Main worktree is unavailable.");
  return await realpath(main);
}

async function sibling(root: string): Promise<string> {
  const parent = await realpath(dirname(root));
  if (!samePath(dirname(root), parent) || !basename(root)) throw new Error("Repository parent changed.");
  const directory = join(parent, `${basename(root)}-worktrees`);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(await realpath(directory), directory)
    || (process.platform !== "win32" && (entry.uid !== process.getuid?.() || (entry.mode & 0o022) !== 0))) {
    throw new Error("Worktree parent must be a private real directory owned by the current user.");
  }
  return directory;
}

async function targetFor(root: string, name: string): Promise<string> {
  validateName(name);
  const directory = await sibling(root);
  const target = join(directory, name);
  if (dirname(target) !== directory) throw new Error("Invalid worktree target.");
  return target;
}

async function configuredFilters(root: string, signal?: AbortSignal): Promise<string[]> {
  let names = "";
  try { names = await git(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], signal); }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  const drivers = new Set<string>();
  for (const key of names.split("\0").filter(Boolean)) {
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(key);
    if (!match || !/^[a-zA-Z0-9_-]{1,128}$/.test(match[1]!)) throw new Error("Unsafe Git filter configuration.");
    drivers.add(match[1]!);
  }
  return [...drivers].flatMap((driver) => ["-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.smudge=`, "-c", `filter.${driver}.process=`, "-c", `filter.${driver}.required=false`]);
}

/** Explicit host action only: never invoked by a model tool. Existing source/index are never touched. */
export async function createIsolatedWorktree(workspace: string, name: string, signal?: AbortSignal): Promise<string> {
  const root = await rootOf(workspace, signal);
  const target = await targetFor(root, name);
  if (!samePath(await realpath(dirname(target)), dirname(target))) throw new Error("Worktree parent changed.");
  // Exclusive creation avoids adopting an attacker-supplied empty directory.
  await mkdir(target, { mode: 0o700 });
  // Create the branch and registered worktree without materializing files. Conditional
  // includeIf/gitdir configuration may differ in the newly registered worktree; discover
  // its effective filter drivers there before running the first checkout/reset.
  await git(root, ["worktree", "add", "--no-checkout", "--no-track", "-b", name, "--", target, "HEAD"], signal);
  await selectIsolatedWorktree(root, name, signal);
  const filters = await configuredFilters(target, signal);
  await git(target, [...filters, "reset", "--hard", "HEAD"], signal);
  return selectIsolatedWorktree(root, name, signal);
}

/** Only already registered sibling worktrees of the same repository can be selected. */
export async function selectIsolatedWorktree(workspace: string, name: string, signal?: AbortSignal): Promise<string> {
  const root = await rootOf(workspace, signal);
  const target = await targetFor(root, name);
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(await realpath(target), target)) throw new Error("Worktree is not a real directory.");
  const listing = await git(root, ["worktree", "list", "--porcelain", "-z"], signal);
  const paths = listing.split("\0").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
  if (!paths.some((path) => samePath(path, target)) || !samePath(await realpath((await git(target, ["rev-parse", "--show-toplevel"], signal)).trim()), target)) throw new Error("Worktree is not registered in this repository.");
  const common = async (path: string) => realpath(resolve(path, (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim()));
  if (await common(root) !== await common(target)) throw new Error("Worktree belongs to another repository.");
  return target;
}
