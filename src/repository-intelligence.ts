import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { portablePath } from "./platform-path.js";

export type RepositoryCommandName = "test" | "typecheck" | "build" | "lint";

export type RepositoryInfo = {
  root: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  packageManagerIndicators: string[];
  node?: { name?: string; type?: string; engines?: Record<string, string>; workspaces?: string[] };
  workspacePackages: Array<{ name: string; root: string }>;
  sourceDirectories: string[];
  testDirectories: string[];
  commands: Partial<Record<RepositoryCommandName, string>>;
  git: { isRepository: boolean; root?: string };
};

const MAX_WORKSPACE_PACKAGES = 20;
const LOCKFILES: ReadonlyArray<readonly [string, RepositoryInfo["packageManager"]]> = [
  ["pnpm-lock.yaml", "pnpm"], ["package-lock.json", "npm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"],
];
const SOURCE_DIRECTORY_NAMES = ["src", "lib", "app"];
const TEST_DIRECTORY_NAMES = ["test", "tests", "__tests__", "spec"];

function isInside(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== "..");
}

async function existingDirectory(root: string, name: string): Promise<boolean> {
  try {
    const candidate = resolve(root, name);
    const resolved = await realpath(candidate);
    return isInside(root, resolved) && (await stat(resolved)).isDirectory();
  } catch { return false; }
}

async function existingFile(root: string, name: string): Promise<boolean> {
  try {
    const candidate = resolve(root, name);
    const resolved = await realpath(candidate);
    return isInside(root, resolved) && (await stat(resolved)).isFile();
  } catch { return false; }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function workspacePatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").slice(0, MAX_WORKSPACE_PACKAGES);
  if (value && typeof value === "object" && Array.isArray((value as { packages?: unknown }).packages)) {
    return (value as { packages: unknown[] }).packages.filter((item): item is string => typeof item === "string").slice(0, MAX_WORKSPACE_PACKAGES);
  }
  return [];
}

async function readPackage(root: string): Promise<Record<string, unknown> | undefined> {
  if (!(await existingFile(root, "package.json"))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

async function discoverWorkspacePackages(root: string, patterns: string[]): Promise<Array<{ name: string; root: string }>> {
  const packages: Array<{ name: string; root: string }> = [];
  for (const pattern of patterns) {
    if (packages.length >= MAX_WORKSPACE_PACKAGES) break;
    const suffix = "/*";
    if (!pattern.endsWith(suffix) || pattern.slice(0, -suffix.length).includes("*")) continue;
    const base = pattern.slice(0, -suffix.length);
    if (!base || !await existingDirectory(root, base)) continue;
    const entries = await readdir(join(root, base), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (packages.length >= MAX_WORKSPACE_PACKAGES || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const packageRoot = join(base, entry.name);
      const metadata = await readPackage(join(root, packageRoot));
      if (metadata) packages.push({ name: typeof metadata.name === "string" ? metadata.name : packageRoot, root: portablePath(packageRoot) });
    }
  }
  return packages;
}

async function discoverGit(root: string): Promise<RepositoryInfo["git"]> {
  // Project context owns detailed Git state; this cheap marker avoids shell execution here.
  return (await existingDirectory(root, ".git")) ? { isRepository: true, root } : { isRepository: false };
}

export async function discoverRepositoryInfo(workingDirectory: string): Promise<RepositoryInfo> {
  const root = await realpath(workingDirectory);
  const indicators = (await Promise.all(LOCKFILES.map(async ([name]) => (await existingFile(root, name)) ? name : undefined)))
    .filter((item): item is string => Boolean(item));
  const managers = new Set(LOCKFILES.filter(([name]) => indicators.includes(name)).map(([, manager]) => manager));
  const packageManager = managers.size === 1 ? [...managers][0] : undefined;
  const metadata = await readPackage(root);
  const scripts = stringRecord(metadata?.scripts);
  const commands = Object.fromEntries((["test", "typecheck", "build", "lint"] as const)
    .filter((name) => typeof scripts?.[name] === "string")
    .map((name) => [name, scripts![name]!])) as RepositoryInfo["commands"];
  const workspaces = workspacePatterns(metadata?.workspaces);
  const [sourceDirectories, testDirectories, workspacePackages, git] = await Promise.all([
    Promise.all(SOURCE_DIRECTORY_NAMES.map(async (name) => (await existingDirectory(root, name)) ? name : undefined)).then((items) => items.filter((item): item is string => Boolean(item))),
    Promise.all(TEST_DIRECTORY_NAMES.map(async (name) => (await existingDirectory(root, name)) ? name : undefined)).then((items) => items.filter((item): item is string => Boolean(item))),
    discoverWorkspacePackages(root, workspaces),
    discoverGit(root),
  ]);
  return {
    root,
    packageManager,
    packageManagerIndicators: indicators.sort(),
    node: metadata ? {
      ...(typeof metadata.name === "string" ? { name: metadata.name } : {}),
      ...(typeof metadata.type === "string" ? { type: metadata.type } : {}),
      ...(stringRecord(metadata.engines) ? { engines: stringRecord(metadata.engines) } : {}),
      ...(workspaces.length > 0 ? { workspaces } : {}),
    } : undefined,
    workspacePackages,
    sourceDirectories,
    testDirectories,
    commands,
    git,
  };
}

export function formatRepositoryInfo(info: RepositoryInfo): string {
  const lines = ["Repository intelligence:"];
  lines.push(`package manager: ${info.packageManager ?? (info.packageManagerIndicators.length > 1 ? `conflicting lockfiles (${info.packageManagerIndicators.join(", ")})` : "not detected")}`);
  if (info.node) lines.push(`Node package: ${info.node.name ?? "unnamed"}${info.node.type ? ` (${info.node.type})` : ""}`);
  if (info.node?.engines?.node) lines.push(`Node engine: ${info.node.engines.node}`);
  if (info.sourceDirectories.length) lines.push(`source directories: ${info.sourceDirectories.join(", ")}`);
  if (info.testDirectories.length) lines.push(`test directories: ${info.testDirectories.join(", ")}`);
  if (info.workspacePackages.length) lines.push(`workspace packages: ${info.workspacePackages.map((item) => `${item.name} (${item.root})`).join(", ")}`);
  const commands = Object.entries(info.commands).map(([name, command]) => `${name}: ${command}`);
  if (commands.length) lines.push(`project scripts: ${commands.join("; ")}`);
  return lines.join("\n");
}
