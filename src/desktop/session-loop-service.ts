import type { DragonsRuntime } from "../runtime.js";
import { createRuntimeSessionLoop } from "../session-loop-runtime.js";
import type { SessionLoop } from "../session-loop.js";

export type DesktopSessionLoopCommand =
  | { action: "start"; sessionId: string; prompt: string; intervalMs: number; maxRuns: number; idleMs?: number }
  | { action: "status"; sessionId?: string }
  | { action: "stop"; sessionId?: string };

/** One process-local READ-only timer for the currently attached Desktop session. */
export function createDesktopSessionLoopService(runtime: DragonsRuntime) {
  let current: SessionLoop | undefined;
  let owner: string | undefined;
  let closed = false;
  let lastReport: string | undefined;
  let failures = 0;
  const stop = async (): Promise<void> => {
    const previous = current;
    current = undefined;
    owner = undefined;
    lastReport = undefined;
    failures = 0;
    await previous?.stop();
  };
  return {
    markActivity(sessionId: string): void {
      if (!closed && owner === sessionId) current?.markActivity();
    },
    async command(command: DesktopSessionLoopCommand): Promise<string> {
      if (closed) throw new Error("Desktop session loop is closed.");
      if (command.action === "status") {
        if (!current || owner !== command.sessionId) return "No Loop/Heartbeat for this session.";
        const state = current.status();
        return `Loop/Heartbeat: ${state.running ? "running" : "stopped"}; completed: ${state.completed}; active: ${state.active}; failures: ${failures}; last report: ${lastReport ?? "none"}`;
      }
      if (command.action === "stop") {
        if (!current || owner !== command.sessionId) return "No Loop/Heartbeat for this session.";
        await stop();
        return "Loop/Heartbeat stopped.";
      }
      if (current?.status().running) throw new Error("Session loop already running.");
      await stop();
      if (closed) throw new Error("Desktop session loop is closed.");
      const loop = createRuntimeSessionLoop({ runtime, config: command,
        onResult: (sessionId, text) => { if (!closed && current === loop && owner === sessionId) lastReport = text.slice(0, 8_000); },
        onError: () => { if (!closed && current === loop) failures += 1; },
      });
      current = loop;
      owner = command.sessionId;
      loop.start();
      return command.idleMs === undefined ? "Loop started (READ-only; current session)." : "Heartbeat started (READ-only; current session).";
    },
    close(): Promise<void> {
      closed = true;
      return stop();
    },
  };
}
