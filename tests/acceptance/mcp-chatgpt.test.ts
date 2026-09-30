import assert from "node:assert/strict";
import test from "node:test";

import { isFixtureRead } from "./mcp-chatgpt.js";

test("external MCP probe authorizes only the exact disposable read", () => {
  assert.equal(isFixtureRead({ path: "/fixture/probe.txt" }, "/fixture/probe.txt"), true);
  for (const input of [null, [], {}, { path: "/fixture/other.txt" }, { path: "/fixture/probe.txt", extra: true }, "\"/fixture/probe.txt\""]) {
    assert.equal(isFixtureRead(input, "/fixture/probe.txt"), false);
  }
});
