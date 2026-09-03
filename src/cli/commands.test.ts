import assert from "node:assert/strict";
import test from "node:test";

import { parseCliCommand } from "./commands.js";

test("command-family parser preserves forwarded and local command shapes", () => {
  assert.deepEqual(parseCliCommand(["--", "memory", "add", "project", "Keep scope local"]), {
    kind: "memory",
    action: "add",
    body: "Keep scope local",
    scope: "project",
  });
  assert.deepEqual(parseCliCommand(["skills", "activate", "review", "--session", "session-1"]), {
    kind: "skills",
    action: "activate",
    id: "review",
    sessionId: "session-1",
  });
  assert.deepEqual(parseCliCommand(["plan", "status", "task-1", "BLOCKED", "--reason", "Needs input", "--session", "session-1"]), {
    kind: "plan",
    action: "status",
    id: "task-1",
    status: "BLOCKED",
    blockedReason: "Needs input",
    sessionId: "session-1",
  });
  assert.deepEqual(parseCliCommand(["mcp", "disconnect", "fixture"]), {
    kind: "mcp",
    action: "disconnect",
    id: "fixture",
  });
});
