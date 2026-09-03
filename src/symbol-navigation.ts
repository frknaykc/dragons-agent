import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { portablePath } from "./platform-path.js";

export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "enum" | "variable";
export type CodeSymbol = { file: string; line: number; kind: SymbolKind; name: string; topLevel: boolean };

const MAX_SYMBOL_RESULTS = 50;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED = new Set([".git", "dist", "node_modules"]);
const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";

function extension(path: string): string { return path.slice(path.lastIndexOf(".")); }

/** Removes comments and strings without moving newlines, then parses declarations from code tokens. */
function codeOnly(source: string): string {
  let output = "";
  let index = 0;
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (index < source.length) {
    const character = source[index]!;
    const next = source[index + 1];
    if (mode === "code" && character === "/" && next === "/") { output += "  "; index += 2; mode = "line"; continue; }
    if (mode === "code" && character === "/" && next === "*") { output += "  "; index += 2; mode = "block"; continue; }
    if (mode === "code" && character === "'") { output += " "; index += 1; mode = "single"; continue; }
    if (mode === "code" && character === '"') { output += " "; index += 1; mode = "double"; continue; }
    if (mode === "code" && character === "`") { output += " "; index += 1; mode = "template"; continue; }
    if (mode === "line" && character === "\n") { output += "\n"; index += 1; mode = "code"; continue; }
    if (mode === "block" && character === "*" && next === "/") { output += "  "; index += 2; mode = "code"; continue; }
    if ((mode === "single" || mode === "double" || mode === "template") && character === "\\") { output += "  "; index += 2; continue; }
    if ((mode === "single" && character === "'") || (mode === "double" && character === '"') || (mode === "template" && character === "`")) { output += " "; index += 1; mode = "code"; continue; }
    output += mode === "code" ? character : character === "\n" ? "\n" : " ";
    index += 1;
  }
  return output;
}

function lineOf(source: string, index: number): number { return source.slice(0, index).split("\n").length; }
function depthAt(source: string, index: number): number {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) { if (source[cursor] === "{") depth += 1; else if (source[cursor] === "}") depth = Math.max(0, depth - 1); }
  return depth;
}

const DECLARATIONS: ReadonlyArray<readonly [RegExp, SymbolKind, number]> = [
  [new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+(${IDENTIFIER})\\b`, "g"), "function", 1],
  [new RegExp(`\\b(?:export\\s+)?(?:abstract\\s+)?class\\s+(${IDENTIFIER})\\b`, "g"), "class", 1],
  [new RegExp(`\\b(?:export\\s+)?interface\\s+(${IDENTIFIER})\\b`, "g"), "interface", 1],
  [new RegExp(`\\b(?:export\\s+)?type\\s+(${IDENTIFIER})\\b`, "g"), "type", 1],
  [new RegExp(`\\b(?:export\\s+)?(?:const\\s+)?enum\\s+(${IDENTIFIER})\\b`, "g"), "enum", 1],
  [new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+(${IDENTIFIER})\\b`, "g"), "variable", 1],
];
const METHOD = new RegExp(`(?:^|\\n)\\s*(?:(?:public|private|protected|static|async|readonly|get|set)\\s+)*(${IDENTIFIER})\\s*\\([^;{}]*\\)\\s*(?::[^={]+)?\\{`, "g");
const RESERVED_METHOD_NAMES = new Set(["if", "for", "while", "switch", "catch", "function"]);

export function symbolsInSource(file: string, source: string): CodeSymbol[] {
  const code = codeOnly(source);
  const symbols: CodeSymbol[] = [];
  for (const [pattern, kind, group] of DECLARATIONS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
      symbols.push({ file, line: lineOf(code, match.index), kind, name: match[group]!, topLevel: depthAt(code, match.index) === 0 });
    }
  }
  METHOD.lastIndex = 0;
  for (let match = METHOD.exec(code); match; match = METHOD.exec(code)) {
    const name = match[1]!;
    const position = match.index + match[0].lastIndexOf(name);
    if (!RESERVED_METHOD_NAMES.has(name) && depthAt(code, position) > 0) symbols.push({ file, line: lineOf(code, position), kind: "method", name, topLevel: false });
  }
  return symbols.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.name.localeCompare(right.name));
}

export async function collectSourceFiles(root: string, directory = root, files: string[] = []): Promise<string[]> {
  if (files.length >= MAX_SYMBOL_RESULTS) return files;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= MAX_SYMBOL_RESULTS || entry.isSymbolicLink()) continue;
    const candidate = resolve(directory, entry.name);
    if (entry.isDirectory()) { if (!IGNORED.has(entry.name)) await collectSourceFiles(root, candidate, files); continue; }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extension(entry.name))) files.push(candidate);
  }
  return files;
}

export async function listFileSymbols(root: string, filePath: string): Promise<CodeSymbol[]> {
  const content = await readFile(filePath, "utf8");
  return symbolsInSource(portablePath(relative(root, filePath)), content).filter((symbol) => symbol.topLevel).slice(0, MAX_SYMBOL_RESULTS);
}

export async function findWorkspaceSymbols(root: string, name: string): Promise<CodeSymbol[]> {
  const files = await collectSourceFiles(root);
  const result: CodeSymbol[] = [];
  for (const file of files) {
    if (result.length >= MAX_SYMBOL_RESULTS) break;
    const content = await readFile(file, "utf8");
    result.push(...symbolsInSource(portablePath(relative(root, file)), content).filter((symbol) => symbol.name === name).slice(0, MAX_SYMBOL_RESULTS - result.length));
  }
  return result;
}

export async function findSyntacticReferences(root: string, name: string): Promise<Array<{ file: string; line: number }>> {
  const files = await collectSourceFiles(root);
  const matcher = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "g");
  const result: Array<{ file: string; line: number }> = [];
  for (const file of files) {
    if (result.length >= MAX_SYMBOL_RESULTS) break;
    const code = codeOnly(await readFile(file, "utf8"));
    matcher.lastIndex = 0;
    for (let match = matcher.exec(code); match; match = matcher.exec(code)) {
      result.push({ file: portablePath(relative(root, file)), line: lineOf(code, match.index) });
      if (result.length >= MAX_SYMBOL_RESULTS) break;
    }
  }
  return result;
}

export function formatSymbols(symbols: readonly CodeSymbol[]): string {
  return symbols.length ? symbols.map((symbol) => `${symbol.file}:${symbol.line}:${symbol.kind} ${symbol.name}`).join("\n") : "No symbols found.";
}

export function formatReferences(references: ReadonlyArray<{ file: string; line: number }>): string {
  return `Syntactic references (not type-aware):\n${references.length ? references.map((reference) => `${reference.file}:${reference.line}`).join("\n") : "No references found."}`;
}
