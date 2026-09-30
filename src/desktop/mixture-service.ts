import { loadDragonsConfig } from "../config.js";
import { parseInteractiveMixtureCommand, type InteractiveMixtureCommand } from "../cli/mixture-commands.js";
import { runMixtureOfAgents } from "../mixture-of-agents.js";
import type { ProviderRegistry } from "../provider/registry.js";
import { createCodingTools, type AgentTool } from "../tools.js";

export type DesktopMixtureCommand =
  | { action: "prepare"; sessionId: string; request: InteractiveMixtureCommand }
  | { action: "confirm"; sessionId: string };

/** Provider selection and confirmation are owned by the trusted Desktop host, never the renderer. */
export function createDesktopMixtureService(options: {
  providers: ProviderRegistry;
  configPath: string;
  workingDirectory: string;
  /** Trusted test-host override only; production creates a fresh built-in tool set. */
  tools?: AgentTool[];
}) {
  let closed = false;
  let active: AbortController | undefined;
  let pending: { sessionId: string; request: InteractiveMixtureCommand; models: string[]; expiresAt: number } | undefined;
  const inFlight = new Set<Promise<string>>();
  const ids = options.providers.ids();
  const modelsFor = async (providers: string[]): Promise<string[]> => {
    const config = await loadDragonsConfig(options.configPath, ids);
    return providers.map((provider) => config.models?.[provider] ?? config.model ?? options.providers.get(provider).defaultModel);
  };

  async function perform(command: DesktopMixtureCommand): Promise<string> {
    if (command.action === "prepare") {
      pending = undefined;
      if (active) throw new Error("MoA already running.");
      if (!parseInteractiveMixtureCommand(
        `/moa ${command.request.preset} ${command.request.providers.join(" ")} --aggregate ${command.request.aggregator} -- ${command.request.question}`, ids))
        throw new Error("Invalid MoA selection.");
      const selected = [...command.request.providers, command.request.aggregator];
      const models = await modelsFor(selected);
      if (closed) throw new Error("Desktop MoA is closed.");
      pending = { sessionId: command.sessionId, request: command.request, models, expiresAt: Date.now() + 60_000 };
      return `MoA sends this question to ${command.request.providers.map((provider, index) => `${provider}:${models[index]}`).join(", ")} and sends their reports to ${command.request.aggregator}:${models.at(-1)}. Type /moa confirm SHARE within 60 seconds to confirm.`;
    }
    const selection = pending;
    pending = undefined;
    if (!selection || selection.sessionId !== command.sessionId || Date.now() > selection.expiresAt)
      return "MoA confirmation not pending; run /moa with a selection first.";
    if (active) throw new Error("MoA already running.");
    const controller = new AbortController();
    active = controller;
    try {
      const chosen = [...selection.request.providers, selection.request.aggregator];
      const models = await modelsFor(chosen);
      if (models.some((value, index) => value !== selection.models[index])) throw new Error("MoA selection changed; run /moa again.");
      if (closed || controller.signal.aborted) throw new Error("Desktop MoA is closed.");
      const tools = options.tools ?? await createCodingTools(options.workingDirectory);
      controller.signal.throwIfAborted();
      const result = await runMixtureOfAgents({ task: selection.request.question, preset: selection.request.preset,
        candidates: selection.request.providers.map((provider, index) => ({ id: provider,
          createModel: () => options.providers.createModel(provider, { model: models[index] }) })),
        createAggregatorModel: () => options.providers.createModel(selection.request.aggregator, { model: models.at(-1)! }),
        tools, signal: controller.signal });
      if (closed || controller.signal.aborted) throw new Error("Desktop MoA is closed.");
      return result.finalText;
    } finally { if (active === controller) active = undefined; }
  }

  return {
    command(input: DesktopMixtureCommand): Promise<string> {
      if (closed) return Promise.reject(new Error("Desktop MoA is closed."));
      const task = perform(input);
      inFlight.add(task);
      void task.then(() => inFlight.delete(task), () => inFlight.delete(task));
      return task;
    },
    async close(): Promise<void> {
      closed = true;
      pending = undefined;
      active?.abort();
      await Promise.allSettled([...inFlight]);
    },
  };
}
