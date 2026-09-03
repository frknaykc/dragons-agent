import { readFile } from "node:fs/promises";

type Hunk = { oldStart: number; oldCount: number; lines: string[] };
type FilePatch = { oldPath?: string; newPath: string; hunks: Hunk[] };
export type PreparedPatch = { path: string; resolvedPath: string; content: string; hunks: number };

function pathFromHeader(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return undefined;
  const normalized = trimmed.replace(/^(?:a|b)\//, "");
  return normalized && !normalized.includes("\t") ? normalized : undefined;
}

function parseRange(value: string): [number, number] | undefined {
  const match = /^(\d+)(?:,(\d+))?$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? "1")];
}

export function parseUnifiedPatch(patch: string): FilePatch[] | string {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: FilePatch[] = [];
  let index = 0;
  while (index < lines.length && lines[index] === "") index += 1;
  while (index < lines.length) {
    const oldHeader = lines[index++];
    const newHeader = lines[index++];
    if (!oldHeader?.startsWith("--- ") || !newHeader?.startsWith("+++ ")) return "Malformed patch file headers.";
    const oldPath = pathFromHeader(oldHeader.slice(4));
    const newPath = pathFromHeader(newHeader.slice(4));
    if (!newPath) return "Patch deletion is not supported.";
    if (oldPath && oldPath !== newPath) return "Patch rename is not supported.";
    const file: FilePatch = { oldPath, newPath, hunks: [] };
    while (index < lines.length && !lines[index]?.startsWith("--- ")) {
      const header = lines[index++];
      const match = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(?:.*)?$/.exec(header ?? "");
      if (!match) return "Malformed patch hunk header.";
      const oldRange = parseRange(match[1]!);
      if (!oldRange) return "Malformed patch hunk range.";
      const hunk: Hunk = { oldStart: oldRange[0], oldCount: oldRange[1], lines: [] };
      while (index < lines.length && !lines[index]?.startsWith("@@ ") && !lines[index]?.startsWith("--- ")) {
        const line = lines[index++]!;
        if (!/^[ +\-]/.test(line)) return "Malformed patch hunk line.";
        hunk.lines.push(line);
      }
      if (!hunk.lines.length) return "Patch hunk has no lines.";
      const oldLines = hunk.lines.filter((line) => line[0] !== "+").length;
      if (oldLines !== hunk.oldCount) return "Patch hunk context count does not match its header.";
      file.hunks.push(hunk);
    }
    if (!file.hunks.length) return "Patch file has no hunks.";
    files.push(file);
  }
  return files.length ? files : "Patch is empty.";
}

export async function preparePatch(
  patch: string,
  resolveWritable: (path: string) => Promise<string | { output: string }>,
): Promise<PreparedPatch[] | string> {
  const parsed = parseUnifiedPatch(patch);
  if (typeof parsed === "string") return parsed;
  const prepared: PreparedPatch[] = [];
  for (const file of parsed) {
    const resolved = await resolveWritable(file.newPath);
    if (typeof resolved !== "string") return resolved.output;
    let source = "";
    try { source = await readFile(resolved, "utf8"); }
    catch (error: unknown) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) return error instanceof Error ? error.message : "Unable to read patch target.";
      if (file.oldPath !== undefined) return `Patch target is missing: ${file.newPath}.`;
    }
    let result = source.replace(/\r\n/g, "\n");
    let offset = 0;
    for (const hunk of file.hunks) {
      const sourceLines = result.split("\n");
      const position = (hunk.oldStart === 0 ? 0 : hunk.oldStart - 1) + offset;
      const oldLines = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
      const replacement = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
      if (position < 0 || oldLines.some((line, lineIndex) => sourceLines[position + lineIndex] !== line)) {
        return `Patch context did not match ${file.newPath} at line ${hunk.oldStart}.`;
      }
      sourceLines.splice(position, oldLines.length, ...replacement);
      result = sourceLines.join("\n");
      offset += replacement.length - oldLines.length;
    }
    prepared.push({ path: file.newPath, resolvedPath: resolved, content: result, hunks: file.hunks.length });
  }
  return prepared;
}
