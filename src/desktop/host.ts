import { createApiKeyAuth } from "../provider/api-key-auth.js";
import { dirname, isAbsolute, join } from "node:path";

import { configureProfileReasoning } from "../reasoning-preferences.js";
import { loadDragonsConfig } from "../config.js";
import { createMemoryStore } from "../memory.js";
import { createBuiltInProviderRegistry } from "../provider/builtins.js";
import { createDesktopLocalControls } from "./local-controls.js";
import type { DesktopLocalControls } from "./bridge.js";
import { createDragonsProfileStore, DEFAULT_DRAGONS_PROFILE, isSafeProfileName } from "../profiles.js";
import { createDragonsRuntime, type DragonsRuntime } from "../runtime.js";
import { createSessionStore } from "../session-store.js";
import { createCodingTools } from "../tools.js";
import { McpClientManager } from "../mcp-client.js";

/** Trusted local composition only. The renderer cannot choose paths or dependencies. */
const localControls = new WeakMap<DragonsRuntime, DesktopLocalControls>();
/** Only runtimes composed by this host can expose local profile/auth controls. */
export function desktopLocalControls(runtime: DragonsRuntime): DesktopLocalControls | undefined { return localControls.get(runtime); }

/** Trusted main-process composition only; never accept these options over IPC.
 * A different config root does NOT isolate OS credentials: the caller must choose
 * a unique profileName for acceptance (credential account labels use only names).
 */
export type DesktopRuntimeOptions = {
  configPath?: string;
  /** Pins this host instance without changing the store's active selection. */
  profileName?: string;
};

export async function createDesktopRuntime(workingDirectory: string, options: DesktopRuntimeOptions = {}): Promise<DragonsRuntime> {
  if (options.configPath !== undefined) {
    if (!isAbsolute(options.configPath)) throw new Error("Desktop configPath must be absolute.");
    if (!options.profileName || options.profileName === DEFAULT_DRAGONS_PROFILE) {
      throw new Error("An injected Desktop config root requires an explicit unique non-default profile name.");
    }
  }
  if (options.profileName !== undefined && !isSafeProfileName(options.profileName)) throw new Error("Invalid Desktop profile name.");
  const profiles = createDragonsProfileStore({ configPath: options.configPath });
  const profile = profiles.paths(options.profileName ?? await profiles.active());
  const config = await loadDragonsConfig(profile.configPath);
  const sessions = createSessionStore(profile.sessionDirectory);
  const apiKeyAuth = createApiKeyAuth(profile.name);
  const { controls, auth: chatgptAuth } = createDesktopLocalControls({
    apiKeyAuth, profiles, profileName: profile.name, sessions, workingDirectory,
    authOptions: {
      credentialPath: join(dirname(profile.configPath), "auth.json"),
      nativeCredentialAccount: profile.credentialAccount,
    },
  });
  const providers = createBuiltInProviderRegistry({
    apiKeyAuth,
    apiKeySlots: config.apiKeySlots,
    localEndpoint: config.localEndpoint,
    chatgptAuth: { credentials: chatgptAuth.credentials },
  });
  configureProfileReasoning(providers, config, profile.configPath);
  controls.reasoning = providers.reasoning.bind(providers);
  const provider = config.provider ?? providers.ids()[0]!;
  controls.defaultProvider = provider;
  const runtime = await createDragonsRuntime({
    workingDirectory,
    providerRegistry: providers,
    defaultProvider: provider,
    defaultModel: config.models?.[provider] ?? config.model,
    maxTurns: config.maxTurns,
    contextBudgetChars: config.contextBudgetChars,
    sessionStore: createSessionStore(profile.sessionDirectory, { providerIds: providers.ids() }),
    memoryStore: createMemoryStore(profile.memoryDirectory),
    skillsDirectory: profile.skillsDirectory,
    tools: await createCodingTools(workingDirectory, {
      maxToolOutputBytes: config.maxToolOutputBytes,
      shellTimeoutMilliseconds: config.shellTimeoutMilliseconds,
    }),
    mcpManager: new McpClientManager(config.mcpServers ?? []),
    lsp: config.lsp,
  });
  localControls.set(runtime, controls);
  return runtime;
}
