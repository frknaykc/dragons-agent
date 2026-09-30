import test from "node:test";
import assert from "node:assert/strict";
import { DesktopBridge, type DesktopLocalControls } from "../../dist/desktop/bridge.js";
import type { DragonsRuntime } from "../../dist/runtime.js";

test("Desktop worktree slash is explicit, idle-only and never rebinds runtime", async () => {
  const calls: string[] = [];
  const runtime = { dispose: async () => {}, providers: () => [] } as unknown as DragonsRuntime;
  const local = { worktree: async (action: "create" | "select", name: string) => {
    calls.push(`${action}:${name}`);
    return `/fixture/worktrees/${name}`;
  }, close: async () => {} } as unknown as DesktopLocalControls;
  const bridge = new DesktopBridge(runtime, () => {}, local);
  try {
    const invalid = await bridge.request({ type: "slash", content: "/worktree create" });
    assert.equal(invalid.ok, true);
    assert.deepEqual(calls, []);
    const result = await bridge.request({ type: "slash", content: "/worktree create safe" });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["create:safe"]);
    assert.match(JSON.stringify(result), /Reopen and select this folder/);
  } finally { await bridge.close(); }
});
