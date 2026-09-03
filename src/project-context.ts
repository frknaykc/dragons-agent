import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { discoverRepositoryInfo, formatRepositoryInfo, type RepositoryInfo } from "./repository-intelligence.js";

export type ProjectInstructions = {
  path: string;
  content: string;
};

export type GitSnapshot = {
  isRepository: boolean;
  repositoryRoot?: string;
  branch?: string;
  dirty?: boolean;
  changedFiles?: string[];
  changedFileCount?: number;
};

export type ProjectContext = {
  instructions?: ProjectInstructions;
  git?: GitSnapshot;
  /** Bounded, current-run repository structure evidence; never persisted with sessions. */
  repository?: RepositoryInfo;
};

const INSTRUCTION_FILE_NAMES = [".hermes.md", "AGENTS.md", "CLAUDE.md", ".cursorrules"];
const MAX_CHANGED_FILES = 20;
const execFileAsync = promisify(execFile);

function isInside(root: string, target: string): boolean {
  const pathRelative = relative(root, target);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== "..");
}

async function discoverProjectInstructions(workspace: string): Promise<ProjectInstructions | undefined> {
  const root = await realpath(workspace);

  for (const name of INSTRUCTION_FILE_NAMES) {
    const candidate = resolve(root, name);
    try {
      const resolved = await realpath(candidate);
      if (!isInside(root, resolved) || !(await stat(resolved)).isFile()) continue;
      return { path: name, content: await readFile(resolved, "utf8") };
    } catch {
      // Missing, unreadable, or invalid instruction entries are ignored.
    }
  }

  return undefined;
}

async function runGit(workspace: string, arguments_: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", arguments_, {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 65_536,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

async function discoverGitSnapshot(workspace: string): Promise<GitSnapshot> {
  const repositoryRoot = (await runGit(workspace, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!repositoryRoot) return { isRepository: false };

  const [branchOutput, statusOutput] = await Promise.all([
    runGit(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(workspace, ["status", "--short", "--untracked-files=normal"]),
  ]);
  const statusLines = statusOutput?.split(/\r?\n/).filter(Boolean) ?? [];
  const changedFileCount = statusLines.length;
  const changedFiles = statusLines
    .slice(0, MAX_CHANGED_FILES)
    .map((line) => line.slice(3));

  return {
    isRepository: true,
    repositoryRoot: resolve(repositoryRoot),
    branch: branchOutput?.trim() || undefined,
    dirty: statusOutput === undefined ? undefined : changedFileCount > 0,
    changedFiles: statusOutput === undefined ? undefined : changedFiles,
    changedFileCount: statusOutput === undefined ? undefined : changedFileCount,
  };
}

export function formatProjectContextForInstructions(context: ProjectContext | undefined): string | undefined {
  if (!context) return undefined;
  const sections: string[] = [];
  if (context.instructions) {
    sections.push(`Repository-local project instructions (${context.instructions.path}):\n${context.instructions.content}`);
  }
  if (context.git?.isRepository) {
    const gitLines = [
      "Git snapshot:",
      `repository root: ${context.git.repositoryRoot ?? "unavailable"}`,
      `branch: ${context.git.branch ?? "detached HEAD"}`,
    ];
    if (context.git.dirty !== undefined) {
      gitLines.push(`working tree: ${context.git.dirty ? "dirty" : "clean"}`);
    }
    if (context.git.changedFiles !== undefined && context.git.changedFileCount !== undefined) {
      gitLines.push(`changed files (${context.git.changedFileCount}): ${context.git.changedFiles.join(", ") || "none"}`);
    }
    sections.push(gitLines.join("\n"));
  }
  if (context.repository) sections.push(formatRepositoryInfo(context.repository));
  return sections.length > 0 ? sections.join("\n") : undefined;
}

export async function discoverProjectContext(workspace: string): Promise<ProjectContext> {
  const [instructions, git, repository] = await Promise.all([
    discoverProjectInstructions(workspace),
    discoverGitSnapshot(workspace),
    discoverRepositoryInfo(workspace),
  ]);
  return { instructions, git, repository };
}
