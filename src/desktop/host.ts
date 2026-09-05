import { loadDragonsConfig } from "../config.js";
import { createBuiltInProviderRegistry } from "../provider/builtins.js";
import { createDragonsRuntime, type DragonsRuntime } from "../runtime.js";
import { createCodingTools } from "../tools.js";
import { McpClientManager } from "../mcp-client.js";

/** Trusted local composition only. The renderer cannot choose paths or dependencies. */
export async function createDesktopRuntime(workingDirectory: string): Promise<DragonsRuntime> {
  const config = await loadDragonsConfig();
  const providers = createBuiltInProviderRegistry({ localEndpoint: config.localEndpoint });
  const provider = config.provider ?? providers.ids()[0]!;
  return createDragonsRuntime({
    workingDirectory,
    providerRegistry: providers,
    defaultProvider: provider,
    defaultModel: config.models?.[provider] ?? config.model,
    maxTurns: config.maxTurns,
    contextBudgetChars: config.contextBudgetChars,
    tools: await createCodingTools(workingDirectory, {
      maxToolOutputBytes: config.maxToolOutputBytes,
      shellTimeoutMilliseconds: config.shellTimeoutMilliseconds,
    }),
    mcpManager: new McpClientManager(config.mcpServers ?? []),
  });
}
