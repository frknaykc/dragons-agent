import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodingTools, createReadTools } from "./tools.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-agent-tools-"));
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "README.md"), "# Example\n");
  await writeFile(join(workspace, "src", "auth.ts"), "export const enabled = false;\n");
  return workspace;
}

function getTool(
  tools: Awaited<ReturnType<typeof createReadTools>>,
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected ${name} tool`);
  return tool;
}

test("read tools inspect files and directories relative to the workspace", async () => {
  const workspace = await createWorkspace();

  try {
    const tools = await createReadTools(workspace);
    const directory = await getTool(tools, "list_directory").execute({ path: "." });
    const file = await getTool(tools, "read_file").execute({ path: "src/auth.ts" });
    const search = await getTool(tools, "search_files").execute({ query: "enabled" });

    assert.deepEqual(directory, { ok: true, output: "README.md\nsrc/" });
    assert.deepEqual(file, { ok: true, output: "export const enabled = false;\n" });
    assert.match(search.output, /src\/auth\.ts:1:export const enabled = false;/);
    assert.equal(search.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coding tools declare their operation classifications", async () => {
  const workspace = await createWorkspace();

  try {
    const tools = await createCodingTools(workspace);

    assert.deepEqual(
      Object.fromEntries(tools.map((tool) => [tool.name, "operation" in tool ? tool.operation : undefined])),
      {
        list_directory: "READ",
        read_file: "READ",
        search_files: "READ",
        grep: "READ",
        project_info: "READ",
        list_symbols: "READ",
        find_symbol: "READ",
        find_references: "READ",
        suggest_tests: "READ",
        review_changes: "READ",
        git_status: "READ",
        git_diff: "READ",
        git_log: "READ",
        write_file: "WRITE",
        edit_file: "WRITE",
        apply_patch: "WRITE",
        shell: "EXECUTE",
      },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read tools return recoverable errors for missing files and path escapes", async () => {
  const workspace = await createWorkspace();

  try {
    const tools = await createReadTools(workspace);
    const readFileTool = getTool(tools, "read_file");

    assert.deepEqual(await readFileTool.execute({ path: "missing.ts" }), {
      ok: false,
      output: "File not found: missing.ts",
    });
    assert.deepEqual(await readFileTool.execute({ path: "../outside.txt" }), {
      ok: false,
      output: "Path must stay within the working directory.",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read tools do not follow symlinks outside the workspace", async () => {
  const workspace = await createWorkspace();
  const outside = await mkdtemp(join(tmpdir(), "dragons-agent-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(workspace, "linked-secret.txt"));

  try {
    const tools = await createReadTools(workspace);
    const result = await getTool(tools, "read_file").execute({
      path: "linked-secret.txt",
    });

    assert.deepEqual(result, {
      ok: false,
      output: "Path must stay within the working directory.",
    });
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("read_file reports binary data instead of returning unusable text", async () => {
  const workspace = await createWorkspace();
  try {
    await writeFile(join(workspace, "image.bin"), Buffer.from([0, 1, 2, 3]));
    const result = await getTool(await createReadTools(workspace), "read_file").execute({ path: "image.bin" });
    assert.deepEqual(result, { ok: false, output: "File appears to be binary and cannot be read as text." });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coding tools write and edit only project files", async () => {
  const workspace = await createWorkspace();

  try {
    const tools = await createCodingTools(workspace);
    const write = await getTool(tools, "write_file").execute({
      path: "src/new.ts",
      content: "export const answer = 41;\n",
    });
    const edit = await getTool(tools, "edit_file").execute({
      path: "src/new.ts",
      oldText: "41",
      newText: "42",
    });

    assert.deepEqual(write, { ok: true, output: "Wrote src/new.ts", changedPaths: ["src/new.ts"] });
    assert.deepEqual(edit, { ok: true, output: "Edited src/new.ts", changedPaths: ["src/new.ts"] });
    assert.equal(
      await readFile(join(workspace, "src", "new.ts"), "utf8"),
      "export const answer = 42;\n",
    );
    assert.deepEqual(
      await getTool(tools, "write_file").execute({
        path: "../outside.ts",
        content: "outside",
      }),
      { ok: false, output: "Path must stay within the working directory." },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("grep searches regex matches with workspace-safe paths and bounded line output", async () => {
  const workspace = await createWorkspace();
  await writeFile(join(workspace, "src", "many.ts"), Array.from({ length: 102 }, () => "const token = true;").join("\n"), "utf8");

  try {
    const grep = getTool(await createReadTools(workspace), "grep");
    const matching = await grep.execute({ pattern: "enabled\\s*=\\s*false" });
    const scoped = await grep.execute({ pattern: "const", path: "src" });
    const invalid = await grep.execute({ pattern: "[" });
    const missing = await grep.execute({ pattern: "token", path: "missing.ts" });
    const escaped = await grep.execute({ pattern: "token", path: "../outside" });
    const limited = await grep.execute({ pattern: "token", path: "src/many.ts" });

    assert.deepEqual(matching, { ok: true, output: "src/auth.ts:1:export const enabled = false;" });
    assert.equal(scoped.ok, true);
    assert.match(scoped.output, /^src\/auth\.ts:1:export const enabled = false;/);
    assert.equal(invalid.ok, false);
    assert.match(invalid.output, /^Invalid regex:/);
    assert.deepEqual(missing, { ok: false, output: "File not found: missing.ts" });
    assert.deepEqual(escaped, { ok: false, output: "Path must stay within the working directory." });
    assert.equal(limited.ok, true);
    assert.equal(limited.output.split("\n").filter((line) => line.startsWith("src/many.ts:")).length, 100);
    assert.match(limited.output, /\[result limit reached: 100\]$/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("edit_file rejects missing or ambiguous target text", async () => {
  const workspace = await createWorkspace();
  await writeFile(join(workspace, "src", "repeated.ts"), "same same\n");

  try {
    const tools = await createCodingTools(workspace);
    const editFile = getTool(tools, "edit_file");

    assert.deepEqual(
      await editFile.execute({
        path: "src/repeated.ts",
        oldText: "missing",
        newText: "replacement",
      }),
      { ok: false, output: "Target text was not found." },
    );
    assert.deepEqual(
      await editFile.execute({
        path: "src/repeated.ts",
        oldText: "same",
        newText: "replacement",
      }),
      { ok: false, output: "Target text is ambiguous." },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("shell runs in the workspace and returns non-zero output as a tool result", async () => {
  const workspace = await createWorkspace();

  try {
    const tools = await createCodingTools(workspace);
    const shell = getTool(tools, "shell");
    const success = await shell.execute({ command: "node -e \"console.log(process.cwd())\"" });
    const failure = await shell.execute({
      command: "node -e \"console.error('broken'); process.exit(2)\"",
    });

    assert.equal(success.ok, true);
    assert.equal(success.output.trim(), await realpath(workspace));
    assert.deepEqual(failure, { ok: false, output: "broken\n" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
