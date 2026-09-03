import { execFile, spawn } from "node:child_process";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { preparePatch } from "./apply-patch.js";
import { formatChangeReview, RunChangeTracker } from "./change-review.js";
import { portablePath } from "./platform-path.js";
import { discoverRepositoryInfo, formatRepositoryInfo } from "./repository-intelligence.js";
import { formatReferences, formatSymbols, findSyntacticReferences, findWorkspaceSymbols, listFileSymbols } from "./symbol-navigation.js";
import { formatTestRecommendations, suggestTests } from "./test-intelligence.js";

export type ToolResult = {
  ok: boolean;
  output: string;
  /** Runtime-only mutation evidence. Providers receive only output. */
  changedPaths?: string[];
};

export type ToolOperation = "READ" | "WRITE" | "EXECUTE";

/** JSON Schema object passed through unchanged to both provider tool adapters. */
export type ToolInputSchema = {
  type: "object";
  [keyword: string]: unknown;
};

export type AgentTool = {
  name: string;
  operation: ToolOperation;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: unknown, options?: ToolExecutionOptions): Promise<ToolResult>;
};

export type ToolExecutionOptions = {
  signal?: AbortSignal;
  /** Runtime-only lifecycle hook. It is never exposed to the model or returned in tool output. */
  onTimeout?: () => void;
  /** Process-local current-run evidence; never provider-visible or persisted. */
  changeTracker?: RunChangeTracker;
};

export type CodingToolOptions = {
  shellTimeoutMilliseconds?: number;
  maxShellOutputBytes?: number;
  maxToolOutputBytes?: number;
};

export type ReadToolOptions = {
  maxToolOutputBytes?: number;
};

type ToolInput = Record<string, unknown>;

const IGNORED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);
const MAX_SEARCH_RESULTS = 100;
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 65_536;
export const DEFAULT_SHELL_TIMEOUT_MILLISECONDS = 60_000;
export const DEFAULT_MAX_SHELL_OUTPUT_BYTES = 1_048_576;
const execFileAsync = promisify(execFile);

function boundOutput(result: ToolResult, maxBytes: number): ToolResult {
  const bytes = Buffer.from(result.output, "utf8");
  if (bytes.length <= maxBytes) return result;
  const marker = `[output truncated at ${maxBytes} bytes]`;
  const available = Math.max(0, maxBytes - Buffer.byteLength(`\n${marker}`));
  return { ...result, output: `${bytes.subarray(0, available).toString("utf8")}\n${marker}` };
}

function isToolInput(input: unknown): input is ToolInput {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function requiredString(input: unknown, key: string): string | ToolResult {
  if (!isToolInput(input) || typeof input[key] !== "string" || !input[key].trim()) {
    return { ok: false, output: `Expected a non-empty string for ${key}.` };
  }

  return input[key].trim();
}

function textValue(
  input: unknown,
  key: string,
  allowEmpty = false,
): string | ToolResult {
  if (!isToolInput(input) || typeof input[key] !== "string") {
    return { ok: false, output: `Expected a string for ${key}.` };
  }

  if (!allowEmpty && input[key] === "") {
    return { ok: false, output: `Expected a non-empty string for ${key}.` };
  }

  return input[key];
}

function isInside(root: string, target: string): boolean {
  const pathRelative = relative(root, target);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== "..");
}

async function resolveWorkspacePath(
  workspace: string,
  requestedPath: string,
): Promise<string | ToolResult> {
  const candidate = resolve(workspace, requestedPath);

  if (!isInside(workspace, candidate)) {
    return { ok: false, output: "Path must stay within the working directory." };
  }

  try {
    const resolved = await realpath(candidate);

    if (!isInside(workspace, resolved)) {
      return { ok: false, output: "Path must stay within the working directory." };
    }

    return resolved;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, output: `File not found: ${requestedPath}` };
    }

    return { ok: false, output: errorMessage(error) };
  }
}

async function resolveWritableWorkspacePath(
  workspace: string,
  requestedPath: string,
): Promise<string | ToolResult> {
  const candidate = resolve(workspace, requestedPath);

  if (!isInside(workspace, candidate)) {
    return { ok: false, output: "Path must stay within the working directory." };
  }

  try {
    const parent = await realpath(dirname(candidate));
    if (!isInside(workspace, parent)) {
      return { ok: false, output: "Path must stay within the working directory." };
    }

    try {
      const existingTarget = await realpath(candidate);
      if (!isInside(workspace, existingTarget)) {
        return { ok: false, output: "Path must stay within the working directory." };
      }
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) {
        return { ok: false, output: errorMessage(error) };
      }
    }

    return candidate;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, output: `Directory not found: ${dirname(requestedPath)}` };
    }

    return { ok: false, output: errorMessage(error) };
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected tool error.";
}

function toolError(error: unknown): ToolResult {
  return { ok: false, output: errorMessage(error) };
}

async function readGit(workspace: string, arguments_: string[], maxBytes: number): Promise<ToolResult> {
  try {
    const { stdout: root } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, encoding: "utf8", maxBuffer: maxBytes });
    if (await realpath(root.trim()) !== workspace) return { ok: false, output: "Git repository root must be the working directory." };
    const { stdout, stderr } = await execFileAsync("git", arguments_, { cwd: workspace, encoding: "utf8", maxBuffer: maxBytes });
    return boundOutput({ ok: true, output: stdout || stderr || "No output." }, maxBytes);
  } catch {
    return { ok: false, output: "Git repository is unavailable in the working directory." };
  }
}

function runShellCommand(
  command: string,
  workingDirectory: string,
  options: Required<CodingToolOptions>,
  signal?: AbortSignal,
  onTimeout?: () => void,
): Promise<ToolResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, output: "Command cancelled." });

  return new Promise((resolveResult) => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(command, {
      cwd: workingDirectory,
      env: environment,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capturedChunks: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let settled = false;
    let termination: "cancelled" | "timed_out" | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const appendOutput = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const remaining = options.maxShellOutputBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const captured = bytes.subarray(0, remaining);
      capturedChunks.push(captured);
      capturedBytes += captured.length;
      if (captured.length < bytes.length) truncated = true;
    };

    const output = (): string => {
      const captured = Buffer.concat(capturedChunks).toString("utf8");
      return truncated
        ? `${captured}${captured.endsWith("\n") || !captured ? "" : "\n"}[output truncated at ${options.maxShellOutputBytes} bytes]`
        : captured;
    };

    const terminateProcessTree = (signalName: NodeJS.Signals): void => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
        return;
      }
      if (child.pid) {
        try {
          process.kill(-child.pid, signalName);
          return;
        } catch {
          // POSIX uses the detached shell's process group; otherwise kill its direct child.
        }
      }
      child.kill(signalName);
    };

    const cancel = (): void => requestTermination("cancelled");
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", cancel);
    };
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(result);
    };
    const requestTermination = (reason: "cancelled" | "timed_out"): void => {
      if (termination) return;
      termination = reason;
      terminateProcessTree("SIGTERM");
      forceKill = setTimeout(() => terminateProcessTree("SIGKILL"), 250);
      forceKill.unref();
    };
    const timeout = setTimeout(() => requestTermination("timed_out"), options.shellTimeoutMilliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      appendOutput(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      appendOutput(chunk);
    });
    child.once("error", (error) => finish(toolError(error)));
    child.once("close", (code) => {
      if (termination === "cancelled") {
        finish({ ok: false, output: "Command cancelled." });
        return;
      }
      if (termination === "timed_out") {
        const captured = output();
        onTimeout?.();
        finish({
          ok: false,
          output: `Command timed out after ${options.shellTimeoutMilliseconds}ms.${captured ? `\n${captured}` : ""}`,
        });
        return;
      }
      const captured = output();
      finish({
        ok: code === 0,
        output: captured || `Command exited with code ${code ?? "unknown"}.`,
      });
    });
  });
}

async function collectMatchingFiles(
  workspace: string,
  directory: string,
  query: string,
  matches: string[],
): Promise<void> {
  if (matches.length >= MAX_SEARCH_RESULTS) {
    return;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (matches.length >= MAX_SEARCH_RESULTS) {
      return;
    }

    const entryPath = resolve(directory, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await collectMatchingFiles(workspace, entryPath, query, matches);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      const content = await readFile(entryPath, "utf8");
      const lines = content.split(/\r?\n/);

      for (const [index, line] of lines.entries()) {
        if (line.includes(query)) {
          matches.push(`${portablePath(relative(workspace, entryPath))}:${index + 1}:${line}`);
          if (matches.length >= MAX_SEARCH_RESULTS) {
            return;
          }
        }
      }
    } catch {
      // A file that cannot be decoded or disappears during traversal is skipped.
    }
  }
}

type RegexSearchState = {
  matches: string[];
  limited: boolean;
};

async function collectRegexMatchesFromFile(
  workspace: string,
  filePath: string,
  pattern: RegExp,
  state: RegexSearchState,
): Promise<void> {
  const content = await readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    pattern.lastIndex = 0;
    if (!pattern.test(line)) continue;
    if (state.matches.length >= MAX_SEARCH_RESULTS) {
      state.limited = true;
      return;
    }
    state.matches.push(`${portablePath(relative(workspace, filePath))}:${index + 1}:${line}`);
  }
}

async function collectRegexMatches(
  workspace: string,
  path: string,
  pattern: RegExp,
  state: RegexSearchState,
): Promise<void> {
  if (state.limited) return;
  const pathStats = await stat(path);
  if (pathStats.isFile()) {
    await collectRegexMatchesFromFile(workspace, path, pattern, state);
    return;
  }
  if (!pathStats.isDirectory()) return;

  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (state.limited) return;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    await collectRegexMatches(workspace, resolve(path, entry.name), pattern, state);
  }
}

export async function createReadTools(
  workingDirectory: string,
  options: ReadToolOptions = {},
): Promise<AgentTool[]> {
  const workspace = await realpath(workingDirectory);
  const maxToolOutputBytes = options.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;

  return [
    {
      name: "list_directory",
      operation: "READ",
      description: "List the files and directories at a project-relative path.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative directory path. Use . for the project root.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input: unknown): Promise<ToolResult> {
        const requestedPath = requiredString(input, "path");
        if (typeof requestedPath !== "string") {
          return requestedPath;
        }

        const directory = await resolveWorkspacePath(workspace, requestedPath);
        if (typeof directory !== "string") {
          return directory;
        }

        try {
          const entries = await readdir(directory, { withFileTypes: true });
          const output = entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
            .join("\n");
          return { ok: true, output };
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    },
    {
      name: "read_file",
      operation: "READ",
      description: "Read a UTF-8 text file at a project-relative path.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path.",
          },
          startLine: { type: "integer", description: "Optional one-based first line to read." },
          endLine: { type: "integer", description: "Optional inclusive one-based last line to read." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input: unknown): Promise<ToolResult> {
        const requestedPath = requiredString(input, "path");
        if (typeof requestedPath !== "string") {
          return requestedPath;
        }

        const filePath = await resolveWorkspacePath(workspace, requestedPath);
        if (typeof filePath !== "string") {
          return filePath;
        }

        try {
          const bytes = await readFile(filePath);
          if (bytes.includes(0)) return { ok: false, output: "File appears to be binary and cannot be read as text." };
          const content = bytes.toString("utf8");
          const rawStartLine = isToolInput(input) ? input.startLine : undefined;
          const rawEndLine = isToolInput(input) ? input.endLine : undefined;
          const startLine = typeof rawStartLine === "number" ? rawStartLine : undefined;
          const endLine = typeof rawEndLine === "number" ? rawEndLine : undefined;
          if ((rawStartLine !== undefined && (typeof rawStartLine !== "number" || !Number.isSafeInteger(rawStartLine) || rawStartLine < 1))
            || (rawEndLine !== undefined && (typeof rawEndLine !== "number" || !Number.isSafeInteger(rawEndLine) || rawEndLine < 1))
            || (startLine !== undefined && endLine !== undefined && startLine > endLine)) {
            return { ok: false, output: "startLine and endLine must be valid one-based line bounds." };
          }
          if (startLine === undefined && endLine === undefined) return boundOutput({ ok: true, output: content }, maxToolOutputBytes);
          const lines = content.split(/\r?\n/);
          const first = (startLine as number | undefined) ?? 1;
          const last = (endLine as number | undefined) ?? lines.length;
          const output = lines.slice(first - 1, last).map((line, index) => `${first + index}:${line}`).join("\n");
          return boundOutput({ ok: true, output }, maxToolOutputBytes);
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    },
    {
      name: "search_files",
      operation: "READ",
      description: "Find lines containing a text query in project files.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search for.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input: unknown): Promise<ToolResult> {
        const query = requiredString(input, "query");
        if (typeof query !== "string") {
          return query;
        }

        try {
          const matches: string[] = [];
          await collectMatchingFiles(workspace, workspace, query, matches);
          const output = matches.join("\n");
          return { ok: true, output: output || "No matches found." };
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    },
    {
      name: "grep",
      operation: "READ",
      description: "Search project file contents with a regular expression and return matching lines.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression pattern to match in each line." },
          path: { type: "string", description: "Optional project-relative file or directory path." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      async execute(input: unknown): Promise<ToolResult> {
        const patternText = requiredString(input, "pattern");
        if (typeof patternText !== "string") return patternText;
        const requestedPath = isToolInput(input) && input.path !== undefined
          ? requiredString(input, "path")
          : ".";
        if (typeof requestedPath !== "string") return requestedPath;

        let pattern: RegExp;
        try {
          pattern = new RegExp(patternText);
        } catch (error: unknown) {
          return { ok: false, output: `Invalid regex: ${errorMessage(error)}` };
        }

        const searchPath = await resolveWorkspacePath(workspace, requestedPath);
        if (typeof searchPath !== "string") return searchPath;

        try {
          const state: RegexSearchState = { matches: [], limited: false };
          await collectRegexMatches(workspace, searchPath, pattern, state);
          const output = state.matches.length === 0
            ? "No matches found."
            : state.matches.join("\n");
          return {
            ok: true,
            output: state.limited ? `${output}\n[result limit reached: ${MAX_SEARCH_RESULTS}]` : output,
          };
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    },
    {
      name: "project_info",
      operation: "READ",
      description: "Return a concise, bounded snapshot of repository structure and native commands.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(): Promise<ToolResult> {
        try { return boundOutput({ ok: true, output: formatRepositoryInfo(await discoverRepositoryInfo(workspace)) }, maxToolOutputBytes); }
        catch (error: unknown) { return toolError(error); }
      },
    },
    {
      name: "list_symbols",
      operation: "READ",
      description: "List bounded top-level JavaScript or TypeScript symbols in one project-relative file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      async execute(input: unknown): Promise<ToolResult> {
        const requestedPath = requiredString(input, "path");
        if (typeof requestedPath !== "string") return requestedPath;
        const filePath = await resolveWorkspacePath(workspace, requestedPath);
        if (typeof filePath !== "string") return filePath;
        try { return boundOutput({ ok: true, output: formatSymbols(await listFileSymbols(workspace, filePath)) }, maxToolOutputBytes); }
        catch (error: unknown) { return toolError(error); }
      },
    },
    {
      name: "find_symbol",
      operation: "READ",
      description: "Find bounded JavaScript or TypeScript symbol definitions by exact name.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      async execute(input: unknown): Promise<ToolResult> {
        const name = requiredString(input, "name");
        if (typeof name !== "string") return name;
        try { return boundOutput({ ok: true, output: formatSymbols(await findWorkspaceSymbols(workspace, name)) }, maxToolOutputBytes); }
        catch (error: unknown) { return toolError(error); }
      },
    },
    {
      name: "find_references",
      operation: "READ",
      description: "Find bounded syntactic (not type-aware) JavaScript or TypeScript identifier references.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      async execute(input: unknown): Promise<ToolResult> {
        const name = requiredString(input, "name");
        if (typeof name !== "string") return name;
        try { return boundOutput({ ok: true, output: formatReferences(await findSyntacticReferences(workspace, name)) }, maxToolOutputBytes); }
        catch (error: unknown) { return toolError(error); }
      },
    },
    {
      name: "suggest_tests",
      operation: "READ",
      description: "Recommend bounded focused, package, and full test commands from project metadata without executing them.",
      inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, additionalProperties: false },
      async execute(input: unknown, executionOptions?: ToolExecutionOptions): Promise<ToolResult> {
        const supplied = isToolInput(input) ? input.paths : undefined;
        if (supplied !== undefined && (!Array.isArray(supplied) || supplied.some((item) => typeof item !== "string"))) return { ok: false, output: "paths must be an array of project-relative strings." };
        const paths = Array.isArray(supplied) ? supplied as string[] : executionOptions?.changeTracker?.files() ?? [];
        try { return boundOutput({ ok: true, output: formatTestRecommendations(await suggestTests(workspace, paths)) }, maxToolOutputBytes); }
        catch (error: unknown) { return toolError(error); }
      },
    },
    {
      name: "review_changes",
      operation: "READ",
      description: "Review current-run mutations separately from pre-existing Git changes; does not modify files or Git state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input: unknown, executionOptions?: ToolExecutionOptions): Promise<ToolResult> {
        if (!executionOptions?.changeTracker) return { ok: true, output: "No current-run change tracker is available." };
        try { return boundOutput({ ok: true, output: formatChangeReview(await executionOptions.changeTracker.review()) }, maxToolOutputBytes); }
        catch (error: unknown) { return toolError(error); }
      },
    },
    {
      name: "git_status",
      operation: "READ",
      description: "Show the working-directory Git status without modifying Git state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(): Promise<ToolResult> { return readGit(workspace, ["status", "--short", "--branch", "--untracked-files=normal"], maxToolOutputBytes); },
    },
    {
      name: "git_diff",
      operation: "READ",
      description: "Show the working-directory Git diff without modifying Git state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(): Promise<ToolResult> { return readGit(workspace, ["diff", "--no-ext-diff", "--"], maxToolOutputBytes); },
    },
    {
      name: "git_log",
      operation: "READ",
      description: "Show the latest Git commits without modifying Git state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(): Promise<ToolResult> { return readGit(workspace, ["log", "--no-decorate", "--oneline", "-n", "20"], maxToolOutputBytes); },
    },
  ];
}

export async function createCodingTools(
  workingDirectory: string,
  options: CodingToolOptions = {},
): Promise<AgentTool[]> {
  const [workspace, readTools] = await Promise.all([
    realpath(workingDirectory),
    createReadTools(workingDirectory, { maxToolOutputBytes: options.maxToolOutputBytes }),
  ]);
  const shellOptions: Required<CodingToolOptions> = {
    shellTimeoutMilliseconds: options.shellTimeoutMilliseconds ?? DEFAULT_SHELL_TIMEOUT_MILLISECONDS,
    maxShellOutputBytes: options.maxShellOutputBytes ?? DEFAULT_MAX_SHELL_OUTPUT_BYTES,
    maxToolOutputBytes: options.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  };

  return [
    ...readTools,
    {
      name: "write_file",
      operation: "WRITE",
      description: "Write UTF-8 text to a project-relative file path.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path." },
          content: { type: "string", description: "Complete UTF-8 file content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute(input: unknown): Promise<ToolResult> {
        const requestedPath = requiredString(input, "path");
        const content = textValue(input, "content", true);
        if (typeof requestedPath !== "string") {
          return requestedPath;
        }
        if (typeof content !== "string") {
          return content;
        }

        const filePath = await resolveWritableWorkspacePath(workspace, requestedPath);
        if (typeof filePath !== "string") {
          return filePath;
        }

        try {
          await writeFile(filePath, content, "utf8");
          return { ok: true, output: `Wrote ${requestedPath}`, changedPaths: [requestedPath] };
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    },
    {
      name: "edit_file",
      operation: "WRITE",
      description: "Replace one exact text occurrence in a project-relative UTF-8 file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path." },
          oldText: { type: "string", description: "Exact text to replace once." },
          newText: { type: "string", description: "Replacement text." },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
      async execute(input: unknown): Promise<ToolResult> {
        const requestedPath = requiredString(input, "path");
        const oldText = textValue(input, "oldText");
        const newText = textValue(input, "newText", true);
        if (typeof requestedPath !== "string") {
          return requestedPath;
        }
        if (typeof oldText !== "string") {
          return oldText;
        }
        if (typeof newText !== "string") {
          return newText;
        }

        const filePath = await resolveWorkspacePath(workspace, requestedPath);
        if (typeof filePath !== "string") {
          return filePath;
        }

        try {
          const content = await readFile(filePath, "utf8");
          const firstMatch = content.indexOf(oldText);
          if (firstMatch < 0) {
            return { ok: false, output: "Target text was not found." };
          }
          if (content.indexOf(oldText, firstMatch + oldText.length) >= 0) {
            return { ok: false, output: "Target text is ambiguous." };
          }

          await writeFile(
            filePath,
            `${content.slice(0, firstMatch)}${newText}${content.slice(firstMatch + oldText.length)}`,
            "utf8",
          );
          return { ok: true, output: `Edited ${requestedPath}`, changedPaths: [requestedPath] };
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    },
    {
      name: "apply_patch",
      operation: "WRITE",
      description: "Apply an all-or-fail, bounded unified patch to project files. Supports modifications and explicit /dev/null file creation; rejects deletion and path escapes.",
      inputSchema: {
        type: "object",
        properties: { patch: { type: "string", description: "Unified diff patch with ---/+++ headers and @@ hunks." } },
        required: ["patch"],
        additionalProperties: false,
      },
      async execute(input: unknown): Promise<ToolResult> {
        const patch = textValue(input, "patch");
        if (typeof patch !== "string") return patch;
        if (Buffer.byteLength(patch, "utf8") > shellOptions.maxToolOutputBytes) return { ok: false, output: `Patch exceeds ${shellOptions.maxToolOutputBytes} byte limit.` };
        const prepared = await preparePatch(patch, async (path) => resolveWritableWorkspacePath(workspace, path));
        if (typeof prepared === "string") return { ok: false, output: prepared };
        try {
          // Every path and hunk has already been resolved and validated before the first write.
          for (const file of prepared) await writeFile(file.resolvedPath, file.content, "utf8");
          const hunks = prepared.reduce((total, file) => total + file.hunks, 0);
          return { ok: true, output: `Applied patch: ${prepared.length} files changed, ${hunks} hunks applied.`, changedPaths: prepared.map((file) => file.path) };
        } catch (error: unknown) { return toolError(error); }
      },
    },
    {
      name: "shell",
      operation: "EXECUTE",
      description: "Run a shell command in the project working directory.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute." },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async execute(input: unknown, executionOptions?: ToolExecutionOptions): Promise<ToolResult> {
        const command = requiredString(input, "command");
        if (typeof command !== "string") {
          return command;
        }

        return runShellCommand(command, workspace, shellOptions, executionOptions?.signal, executionOptions?.onTimeout);
      },
    },
  ];
}
