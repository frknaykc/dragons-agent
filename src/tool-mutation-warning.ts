import { RuntimeTextRedactor } from "./runtime-redaction.js";
import type { ToolResult } from "./tools.js";

/** Presentation-only metadata: never forward raw errors or tool arguments. */
export function toolMutationWarning(result: Pick<ToolResult, "ok" | "changedPaths" | "rollbackCoverage">): string | undefined {
  // Render fixed text only, not arbitrary metadata strings or tool output.
  const coverage = result.rollbackCoverage?.kind === "unsupported"
    ? "Warning: outside rollback coverage; no checkpoint captured." : undefined;
  if (result.ok || !result.changedPaths?.length) return coverage;
  const paths = result.changedPaths.slice(0, 16).map((path) => {
    const redactor = new RuntimeTextRedactor();
    // Redact before truncation; JSON escaping makes control characters inert.
    const safe = redactor.push(path) + redactor.finish();
    return safe.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�").slice(0, 256);
  });
  return `${coverage ? `${coverage} ` : ""}Warning: write failed; these paths may have changed and recovery is uncertain: ${JSON.stringify(paths)}. Inspect before retrying.${result.changedPaths.length > 16 ? " Additional paths omitted." : ""}`;
}
