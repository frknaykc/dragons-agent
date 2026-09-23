import { isAbsolute } from "node:path";
import { safeLspText } from "./lsp-diagnostics.js";

/** Only this explicitly allowlisted scope crosses client boundaries, never tool arguments. */
export type LspApproval = { command: string; args: string[]; document: string };
const MAX_SCOPE = 4096;
export function validateLspApproval(value: unknown): LspApproval | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "args,command,document"
    || typeof v.command !== "string" || !isAbsolute(v.command)
    || typeof v.document !== "string" || !v.document || v.document.length > 512
    || !Array.isArray(v.args) || v.args.length > 16) return undefined;
  const fields = [v.command, ...v.args, v.document];
  // Redaction/truncation would hide execution identity: deny instead of showing an ambiguous scope.
  if (fields.some((s) => typeof s !== "string" || s.length > 2048
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(s) || s.includes("[REDACTED]")
    || /(?:^|[\s=])--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential|authorization|auth)(?:[=\s]|$)/i.test(s)
    || safeLspText(s, 2049) !== s)) return undefined;
  const scope = { command: v.command, args: [...v.args] as string[], document: v.document };
  return Buffer.byteLength(JSON.stringify(scope)) <= MAX_SCOPE ? scope : undefined;
}
export function lspApprovalFromArguments(arguments_: string): LspApproval | undefined {
  if (arguments_.length > MAX_SCOPE) return undefined;
  try {
    const v = JSON.parse(arguments_);
    if (!v || typeof v !== "object" || Object.keys(v).sort().join(",") !== "args,command,path") return undefined;
    return validateLspApproval({ command: v.command, args: v.args, document: v.path });
  } catch { return undefined; }
}
export function formatLspApproval(scope: LspApproval): string {
  return `Command: ${JSON.stringify(scope.command)}\nArgs: ${JSON.stringify(scope.args)}\nDocument: ${JSON.stringify(scope.document)}`;
}
