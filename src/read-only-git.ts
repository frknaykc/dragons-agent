import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** Internal READ-only Git boundary. Callers supply fixed commands, never shell input. */
export async function readOnlyGit(workspace: string, arguments_: string[], maxBytes: number) {
  // READ must not run repository-configured helpers or refresh the index on disk.
  const safeConfig = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, "-c", "log.showSignature=false", "-c", "diff.submodule=short"];
  const { stdout: root } = await execFileAsync("git", [...safeConfig, "rev-parse", "--show-toplevel"], { cwd: workspace, encoding: "utf8", maxBuffer: maxBytes });
  if (await realpath(root.trim()) !== await realpath(workspace)) throw new Error("Git repository root must be the working directory.");
  let filtersDisabled = false;
  if (arguments_[0] === "diff" || arguments_[0] === "status") {
    // Git may run clean/process filters while comparing worktree bytes. Override
    // each configured driver rather than disabling Git in every LFS-enabled repo.
    let filterKeys = "";
    try {
      filterKeys = (await execFileAsync("git", [...safeConfig, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"], { cwd: workspace, encoding: "utf8", maxBuffer: maxBytes })).stdout;
    } catch (error: unknown) {
      // Exit 1 means no matching keys; every other failure must fail closed.
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === 1)) throw error;
    }
    for (const key of new Set(filterKeys.split("\0").filter(Boolean))) {
      const driver = key.replace(/\.(clean|process)$/, "");
      safeConfig.push("-c", `${driver}.clean=`, "-c", `${driver}.process=`, "-c", `${driver}.required=false`);
      filtersDisabled = true;
    }
  }
  const { stdout, stderr } = await execFileAsync("git", [...safeConfig, ...arguments_], { cwd: workspace, encoding: "utf8", maxBuffer: maxBytes });
  return { stdout, stderr, filtersDisabled };
}
