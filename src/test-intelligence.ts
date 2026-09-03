import { access } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { discoverRepositoryInfo, type RepositoryInfo } from "./repository-intelligence.js";

export type TestRecommendation = { level: "focused" | "package" | "full"; command: string; reason: string };

function isInside(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== "..");
}

function runner(info: RepositoryInfo): string | undefined {
  return info.packageManager ?? (info.node ? "npm" : undefined);
}

async function fileExists(root: string, path: string): Promise<boolean> {
  const candidate = resolve(root, path);
  if (!isInside(root, candidate)) return false;
  try { await access(candidate); return true; } catch { return false; }
}

function testCandidates(path: string): string[] {
  const extensionIndex = path.lastIndexOf(".");
  if (extensionIndex < 0) return [];
  const stem = path.slice(0, extensionIndex);
  const extension = path.slice(extensionIndex);
  return [`${stem}.test${extension}`, `${stem}.spec${extension}`, `${stem}.test.ts`, `${stem}.test.js`];
}

export async function suggestTests(root: string, changedPaths: readonly string[]): Promise<TestRecommendation[]> {
  const info = await discoverRepositoryInfo(root);
  const packageRunner = runner(info);
  const paths = changedPaths.filter((path) => typeof path === "string" && path && !path.includes("\0") && isInside(root, resolve(root, path))).slice(0, 20);
  const recommendations: TestRecommendation[] = [];
  if (info.commands.test && packageRunner) {
    for (const changed of paths) {
      for (const candidate of testCandidates(changed)) {
        if (await fileExists(root, candidate)) {
          recommendations.push({ level: "focused", command: `${packageRunner} test -- ${candidate}`, reason: `matching test for ${changed}` });
          break;
        }
      }
      if (recommendations.length) break;
    }
    recommendations.push({ level: "package", command: `${packageRunner} test`, reason: "project test script" });
  }
  const fullParts = [
    info.commands.test && packageRunner ? `${packageRunner} test` : undefined,
    info.commands.typecheck && packageRunner ? `${packageRunner} run typecheck` : undefined,
    info.commands.build && packageRunner ? `${packageRunner} run build` : undefined,
  ].filter((part): part is string => Boolean(part));
  if (fullParts.length) recommendations.push({ level: "full", command: fullParts.join(" && "), reason: "project verification scripts" });
  return recommendations.slice(0, 10);
}

export function formatTestRecommendations(recommendations: readonly TestRecommendation[]): string {
  return recommendations.length
    ? recommendations.map((item) => `${item.level}: ${item.command} (${item.reason})`).join("\n")
    : "No trusted test recommendation is available from project metadata.";
}
