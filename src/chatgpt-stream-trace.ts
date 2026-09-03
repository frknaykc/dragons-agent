import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseToolCallArguments, type AgentModel } from "./agent.js";
import { createCodingTools, type AgentTool } from "./tools.js";
import { createChatGPTAuthService } from "./provider/codex-auth.js";
import { createCodexAgentModel, type CodexStreamDiagnostic } from "./provider/codex.js";

export type ChatGPTStreamTraceResult = {
  trace: readonly CodexStreamDiagnostic[];
  liveRead: boolean;
  toolResultOk: boolean;
  toolDiagnostic?: ReadToolDiagnostic;
  finalStreamed: boolean;
  failure?: string;
  cleanedUp: boolean;
};

export type ReadToolDiagnostic = {
  toolName: "read_file";
  argumentsParsed: boolean;
  argumentShape: "path_string" | "missing_path" | "non_object" | "invalid_json";
  requestedRelativePath?: string;
  ok: boolean;
};

/** Produces bounded result evidence without retaining tool output or arbitrary arguments. */
export function classifyReadToolDiagnostic(toolName: string, serializedArguments: string, result: { ok: boolean }, fixtureName: string): ReadToolDiagnostic | undefined {
  if (toolName !== "read_file") return undefined;
  let input: unknown;
  try { input = JSON.parse(serializedArguments) as unknown; } catch {
    return { toolName: "read_file", argumentsParsed: false, argumentShape: "invalid_json", ok: result.ok };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return { toolName: "read_file", argumentsParsed: true, argumentShape: "non_object", ok: result.ok };
  const path = (input as Record<string, unknown>).path;
  if (typeof path !== "string" || !path.trim()) return { toolName: "read_file", argumentsParsed: true, argumentShape: "missing_path", ok: result.ok };
  const normalized = path.trim();
  const base = { toolName: "read_file" as const, argumentsParsed: true, argumentShape: "path_string" as const, ...(normalized === fixtureName ? { requestedRelativePath: fixtureName } : {}), ok: result.ok };
  return base;
}

export type ChatGPTStreamTraceDependencies = {
  model?: AgentModel;
  tools?: (directory: string) => Promise<AgentTool[]>;
  write?: (text: string) => void;
  trace?: CodexStreamDiagnostic[];
};

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected stream trace failure.";
  return message.replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}

/** Runs one disposable READ-only trace and always emits only structural diagnostics. */
export async function runChatGPTStreamTrace(dependencies: ChatGPTStreamTraceDependencies = {}): Promise<ChatGPTStreamTraceResult> {
  const directory = await mkdtemp(join(tmpdir(), "dragons-chatgpt-stream-"));
  const trace = dependencies.trace ?? [];
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  let liveRead = false;
  let toolResultOk = false;
  let toolDiagnostic: ReadToolDiagnostic | undefined;
  let finalStreamed = false;
  let failure: string | undefined;
  try {
    const fixtureName = "README.txt";
    await writeFile(join(directory, fixtureName), "safe fixture\n");
    const tools = await (dependencies.tools ?? createCodingTools)(directory);
    const model = dependencies.model ?? createCodexAgentModel({
      credentials: createChatGPTAuthService().credentials,
      onStreamDiagnostic: (entry) => trace.push(entry),
    });
    const first = await model.respond({
      task: "Use read_file exactly once to inspect README.txt and report one fact. Do not modify files.",
      tools,
      toolOutputs: [],
    });
    if (first.toolCalls.length !== 1 || first.toolCalls[0]?.name !== "read_file") throw new Error("Minimal trace did not receive exactly one READ tool call.");
    const call = first.toolCalls[0]!;
    const tool = tools.find((candidate) => candidate.name === call.name);
    if (!tool) throw new Error("Required READ tool is unavailable.");
    const input = parseToolCallArguments(call.arguments);
    if (typeof input === "object" && input !== null && "ok" in input) throw new Error("Minimal trace received malformed tool arguments.");
    const result = await tool.execute(input);
    liveRead = true;
    toolResultOk = result.ok;
    toolDiagnostic = classifyReadToolDiagnostic(call.name, call.arguments, result, fixtureName);
    const second = await model.respond({
      task: "Provide a concise completion report.",
      tools,
      previousResponseId: first.responseId,
      toolOutputs: [{ callId: call.callId, output: result.output }],
    });
    finalStreamed = Boolean(second.textWasStreamed);
  } catch (error: unknown) {
    failure = safeFailure(error);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const output = { trace, liveRead, toolResultOk, ...(toolDiagnostic ? { toolDiagnostic } : {}), finalStreamed, ...(failure ? { failure } : {}), cleanedUp: true } satisfies ChatGPTStreamTraceResult;
  write(`CHATGPT_STREAM_TRACE ${JSON.stringify(output)}\n`);
  return output;
}

if (process.argv[1]?.endsWith("chatgpt-stream-trace.js")) {
  void runChatGPTStreamTrace().then((result) => { if (result.failure) process.exitCode = 1; });
}
