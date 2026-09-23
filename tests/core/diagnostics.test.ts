import assert from "node:assert/strict";
import test from "node:test";
import { formatRuntimeDiagnostics, RuntimeDiagnosticsService } from "../../dist/diagnostics.js";

test("adopted diagnostics identity is safe, bounded, isolated and immutable after completion", () => {
  const service = new RuntimeDiagnosticsService();
  const run = service.start({ provider: "primary", model: "original" });
  for (let i = 0; i < 10; i++) run.recordIdentityTransition({ provider: "target", model: `model-${i}` });
  run.recordIdentityTransition({ provider: "authorization-private", model: "unsafe context with spaces" });
  const summary = run.complete("cancelled");
  assert.equal(summary.provider, undefined);
  assert.equal(summary.model, undefined);
  assert.deepEqual(summary.initialIdentity, { provider: "primary", model: "original" });
  assert.equal(summary.identityTransitions?.length, 3);
  assert.deepEqual(summary.identityTransitions?.at(-1), {});
  assert.doesNotMatch(JSON.stringify(summary), /authorization-private|unsafe context/);
  run.recordIdentityTransition({ provider: "late", model: "late" });
  assert.deepEqual(run.complete("success"), summary);
  summary.identityTransitions!.push({ provider: "mutated" });
  assert.equal(service.recent()[0]!.identityTransitions!.length, 3);
  assert.equal(service.start({ provider: "other" }).complete("success").initialIdentity, undefined);
});

test("identity transitions replace rather than merge partially safe labels", () => {
  const run = new RuntimeDiagnosticsService().start({ provider: "primary", model: "original" });
  run.recordIdentityTransition({ provider: "target", model: "x".repeat(129) });
  const summary = run.complete("failed");
  assert.equal(summary.provider, "target");
  assert.equal(summary.model, undefined);
  assert.deepEqual(summary.identityTransitions, [{ provider: "target" }]);
});

test("formatted diagnostics expose only bounded adopted identity history", () => {
  const run = new RuntimeDiagnosticsService().start({ provider: "primary", model: "original" });
  run.recordIdentityTransition({ provider: "target", model: "target-model" });
  const output = formatRuntimeDiagnostics(run.complete("success"));
  assert.match(output, /initial primary\/original/);
  assert.match(output, /fallback target\/target-model/);
  assert.doesNotMatch(output, /context|consent|request/i);
});
