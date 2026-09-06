import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDragonsConfig } from "./config.js";
import { createBuiltInProviderRegistry } from "./provider/builtins.js";
import { createChatGPTAuthService } from "./provider/codex-auth.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { classifyProviderError } from "./retry.js";
import { createDragonsRuntime, type RuntimeRunHandle } from "./runtime.js";
import { createSessionStore } from "./session-store.js";
import { createReadTools } from "./tools.js";

/** Evidence only: injected descriptors are deterministic, never automatically labelled live. */
export async function exerciseProvider(descriptor: ProviderDescriptor, model: string, secrets: readonly string[] = [], timeoutMs = 60_000) {
  const root = await mkdtemp(join(tmpdir(), "dragons-provider-acceptance-"));
  const workspace = join(root, "workspace");

  await mkdir(workspace);
  const sentinel = `fixture-${randomBytes(8).toString("hex")}`;
  await writeFile(join(workspace, "fixture.txt"), sentinel);
  const evidence = { text: false, toolCall: false, continuation: false, streaming: false, multiTurn: false, isolation: false, cancellation: false, usage: false, secretAudit: true, cleanup: false, failure: "", requests: 0, retries: 0 };
  let handle: RuntimeRunHandle | undefined;
  let cancelOnDelta = false;
  let timedOut = false;
  let successfulRead = false;
  let deltas = 0;
  const audit = (value: unknown): void => {
    const text = JSON.stringify(value) ?? "";
    if (secrets.some((secret) => secret.length >= 8 && text.includes(secret))) {
      evidence.secretAudit = false;
      throw new Error("ACCEPTANCE_SECRET_LEAK");
    }
  };
  const registry = createProviderRegistry([{ ...descriptor, createModel(context) {
    const adapter = descriptor.createModel(context);
    return { async respond(request, onDelta) {
      evidence.requests += 1;
      if (evidence.requests > 8) throw new Error("ACCEPTANCE_REQUEST_BOUND");
      if (cancelOnDelta) evidence.isolation = !request.continuationState && !request.conversationResponseId && !request.previousResponseId && request.toolOutputs.length === 0;
      if (request.conversationResponseId || request.continuationState) evidence.multiTurn = true;
      const continuedRead = successfulRead && request.toolOutputs.some((item) => item.output.includes(sentinel));
      try {
        const result = await adapter.respond({ ...request, onProviderRetry() { evidence.retries += 1; request.onProviderRetry?.(); } }, (text) => {
          deltas += 1;
          if (cancelOnDelta) handle?.cancel();
          onDelta?.(text);
        });
        if (continuedRead && result.text.includes(sentinel)) evidence.continuation = true;
        evidence.usage ||= result.usage !== undefined;
        return result;
      } catch (error) {
        evidence.failure = classifyProviderError(error);
        throw error;
      }
    } };
  } }]);
  const runtime = await createDragonsRuntime({
    workingDirectory: workspace, providerRegistry: registry,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: registry.ids() }),
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
    tools: (await createReadTools(workspace, { maxToolOutputBytes: 1024 })).filter((tool) => tool.name === "read_file"),
    maxTurns: 3, contextBudgetChars: 24_000,
  });
  const timer = setTimeout(() => { timedOut = true; handle?.cancel(); }, timeoutMs);
  async function run(sessionId: string, content: string) {
    if (timedOut) throw new Error("ACCEPTANCE_TIMEOUT");
    handle = await runtime.sendUserInput({ sessionId, content });
    const settled = handle.result.then((result) => ({ result }), (error: unknown) => {
      try { audit(error instanceof Error ? { name: error.name, message: error.message } : error); }
      catch { evidence.failure = "secret_leak"; }
      return { result: undefined };
    });
    if (timedOut) handle.cancel();
    let cancelled = false;
    for await (const event of handle.events) {
      audit(event);
      if (event.type === "approval_requested") runtime.resolveAuthorization({ runId: event.runId, approvalId: event.approvalId, decision: "deny" });
      if (event.type === "memory_suggestion") await runtime.resolveMemorySuggestion({ ...event, decision: "reject" });
      if (event.type === "run_cancelled") cancelled = true;
      if (event.type === "tool_activity" && event.phase === "completed" && event.toolName === "read_file" && event.operation === "READ" && event.ok && event.output?.includes(sentinel)) successfulRead = true;
    }
    const { result } = await settled;
    if (result) audit(result);
    return { result, cancelled };
  }
  try {
    const session = await runtime.createSession({ provider: descriptor.id, model });
    const first = await run(session.id, "Do not call any tools. Reply with exactly DRAGONS_READY.");
    evidence.text = first.result?.finalText.trim() === "DRAGONS_READY";
    evidence.streaming = deltas > 0;
    if (!first.result) return evidence;
    const second = await run(session.id, "Use read_file to read fixture.txt exactly once. Do not call any other tools. Reply with only the complete file contents, without formatting.");
    evidence.toolCall = successfulRead;
    evidence.continuation &&= second.result?.finalText.trim() === sentinel;
    if (!second.result) return evidence;
    const other = await runtime.createSession({ provider: descriptor.id, model });
    cancelOnDelta = true;
    const cancelled = await run(other.id, "Do not use tools. Write the integers from 1 through 200 separated by spaces.");
    evidence.cancellation = cancelled.cancelled && !cancelled.result && !timedOut;
    if (evidence.cancellation && evidence.failure === "cancelled") evidence.failure = "";
    audit(await runtime.status({ sessionId: session.id }));
    return evidence;
  } catch {
    if (!evidence.failure) evidence.failure = evidence.secretAudit ? "acceptance_incomplete" : "secret_leak";
    return evidence;
  } finally {
    clearTimeout(timer);
    try {
      await runtime.dispose();
      async function auditFiles(directory: string): Promise<void> {
        for (const item of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, item.name);
          if (item.isDirectory()) await auditFiles(path);
          else audit(await readFile(path, "utf8"));
        }
      }
      await auditFiles(root);
    } finally {
      await rm(root, { recursive: true, force: true });
      evidence.cleanup = true;
      if (timedOut) evidence.failure = "acceptance_timeout";
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const provider = args[args.indexOf("--provider") + 1];
  if (!args.includes("--live") || !args.includes("--provider")) throw new Error("OPT_IN_REQUIRED");
  const config = await loadDragonsConfig();
  const auth = createChatGPTAuthService({ write: () => {} });
  const secrets: string[] = [];
  const registry = createBuiltInProviderRegistry({ localEndpoint: config.localEndpoint, chatgptAuth: { credentials: {
    async getValidCredentials() {
      const credentials = await auth.credentials.getValidCredentials();
      secrets.push(credentials.accessToken, credentials.refreshToken);
      return credentials;
    },
  } } });
  if (!registry.has(provider)) throw new Error("UNKNOWN_PROVIDER");
  const keyNames: Record<string, string> = { "openai-api": "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
  const key = keyNames[provider];
  if (key && !process.env[key]?.trim()) {
    process.stdout.write(JSON.stringify({ provider, status: "BLOCKED_BY_CREDENTIAL", prerequisite: key }) + "\n");
    return;
  }
  if (key) secrets.push(process.env[key]!);
  if (provider === "chatgpt" && !(await auth.status()).authenticated) {
    process.stdout.write(JSON.stringify({ provider, status: "BLOCKED_BY_CREDENTIAL", prerequisite: "dragons auth login --provider chatgpt" }) + "\n");
    return;
  }
  const descriptor = registry.get(provider);
  const model = config.models?.[provider] ?? (config.provider === provider ? config.model : undefined) ?? descriptor.defaultModel;
  const evidence = await exerciseProvider(descriptor, model, secrets);
  const verified = evidence.text && evidence.streaming && evidence.toolCall && evidence.continuation && evidence.multiTurn && evidence.isolation && evidence.cancellation && evidence.secretAudit && evidence.cleanup && !evidence.failure;
  // Failures require human evidence review; never infer missing credentials or an upstream outage from a generic error.
  const safeModel = /^[A-Za-z0-9._:/-]{1,128}$/.test(model) && !secrets.some((secret) => secret.length >= 8 && model.includes(secret)) ? model : "CONFIGURED_MODEL";
  process.stdout.write(JSON.stringify({ provider, model: safeModel, status: verified ? "LIVE_VERIFIED" : "REQUIRES_CLASSIFICATION", evidence }) + "\n");
  if (!verified) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // A hard process bound covers native credential-store and pre-admission hangs as well.
  const watchdog = setTimeout(() => { process.stderr.write("ACCEPTANCE_HARD_TIMEOUT\n"); process.exit(1); }, 90_000);
  void main().catch(() => { process.stderr.write("ACCEPTANCE_FAILED_REQUIRES_CLASSIFICATION\n"); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
}
