import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";

export type ChangeReview = {
  runLocalFiles: string[];
  preExistingGitFiles: string[];
  unexpectedGitFiles: string[];
  gitAvailable: boolean;
  diffSummary: string;
};

const execFileAsync = promisify(execFile);
const MAX_FILES = 20;
const MAX_DIFF_CHARS = 12_000;

export class RunChangeTracker {
  private readonly changed = new Set<string>();
  private preExistingGitFiles: string[] = [];
  private initialized = false;

  constructor(private readonly workspace: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.preExistingGitFiles = await gitChangedFiles(this.workspace);
  }

  record(paths: readonly string[] | undefined): void {
    for (const path of paths ?? []) if (typeof path === "string" && path && this.changed.size < MAX_FILES) this.changed.add(path);
  }

  files(): string[] { return [...this.changed].sort(); }

  async review(): Promise<ChangeReview> {
    await this.initialize();
    const current = await gitChangedFiles(this.workspace);
    const runLocalFiles = this.files();
    const known = new Set([...this.preExistingGitFiles, ...runLocalFiles]);
    const unexpectedGitFiles = current.filter((path) => !known.has(path)).slice(0, MAX_FILES);
    const diffSummary = await gitDiffFor(this.workspace, runLocalFiles);
    return { runLocalFiles, preExistingGitFiles: this.preExistingGitFiles, unexpectedGitFiles, gitAvailable: current.length > 0 || await isGit(this.workspace), diffSummary };
  }
}

async function isGit(workspace: string): Promise<boolean> {
  try { await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspace, encoding: "utf8" }); return true; } catch { return false; }
}

async function gitChangedFiles(workspace: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: workspace, encoding: "utf8", maxBuffer: 65_536 });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).sort().slice(0, MAX_FILES);
  } catch { return []; }
}

async function gitDiffFor(workspace: string, paths: string[]): Promise<string> {
  if (!paths.length) return "No run-local diff is available.";
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", "--stat", "--", ...paths], { cwd: workspace, encoding: "utf8", maxBuffer: MAX_DIFF_CHARS });
    return stdout.slice(0, MAX_DIFF_CHARS) || "No Git diff is available for run-local files.";
  } catch { return "Git diff is unavailable; run-local tool mutations are listed above."; }
}

export function formatChangeReview(review: ChangeReview): string {
  const lines = [
    `run-local files: ${review.runLocalFiles.join(", ") || "none"}`,
    `pre-existing Git files: ${review.preExistingGitFiles.join(", ") || "none"}`,
    `unexpected Git files: ${review.unexpectedGitFiles.join(", ") || "none"}`,
    `Git review: ${review.gitAvailable ? "available" : "unavailable"}`,
    `diff summary:\n${review.diffSummary}`,
  ];
  return lines.join("\n");
}
