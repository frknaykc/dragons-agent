import { loadDragonsConfig, saveDragonsConfig, type DragonsConfig } from "./config.js";
import type { ProviderRegistry } from "./provider/registry.js";

/** Host-only wiring: profile path never comes from a renderer or runtime request. */
export function configureProfileReasoning(providers: ProviderRegistry, config: DragonsConfig, configPath?: string): void {
  // Catalogue validation occurs against the actual host registry, before any request.
  providers.configureFallback(config.fallback ? { enabled: config.fallback.enabled, targets: config.fallback.targets } : undefined);
  providers.configureReasoning(config.reasoning, async (reasoning) => {
    // Merge the current file so choosing effort cannot overwrite a newer model/provider setting.
    const current = await loadDragonsConfig(configPath, providers.ids());
    await saveDragonsConfig({ ...config, ...current, reasoning }, configPath, providers.ids());
    config.reasoning = reasoning;
  });
}
