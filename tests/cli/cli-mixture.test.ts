import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { main } from "../../dist/cli.js";
import { parseInteractiveMixtureCommand } from "../../dist/cli/mixture-commands.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";

const ids = ["alpha", "beta", "gamma"];

function registry() {
  return createProviderRegistry(ids.map((id) => ({ id, label: id, defaultModel: `${id}-default`, credentialRequirement: "none" as const,
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond() { throw new Error("Registry model must not be created in fixture."); } }),
  })));
}

const command = "/moa duo alpha beta --aggregate gamma -- What changed?";

test("MoA CLI parser accepts explicit distinct registered providers and bounded questions", () => {
  assert.deepEqual(parseInteractiveMixtureCommand(command, ids), { preset: "duo", providers: ["alpha", "beta"], aggregator: "gamma", question: "What changed?" });
  for (const bad of ["/moa duo alpha alpha --aggregate gamma -- Inspect", "/moa duo alpha missing --aggregate gamma -- Inspect",
    "/moa trio alpha beta --aggregate gamma -- Inspect", "/moa duo alpha beta --aggregate missing -- Inspect",
    "/moa duo alpha beta --aggregate gamma -- ", "/moa duo alpha beta --aggregate gamma -- Bad\u001b[31m",
    `/moa duo alpha beta --aggregate gamma -- ${"x".repeat(4_001)}`]) assert.equal(parseInteractiveMixtureCommand(bad, ids), undefined);
});

test("CLI MoA requires separate SHARE confirmation and never sends rejected or malformed commands to a model", async () => {
  const sent: string[] = [];
  const output: string[] = [];
  await main([], { providerRegistry: registry(), config: { provider: "alpha" }, tools: [],
    modelFactory: (id) => { sent.push(id); return { async respond() { throw new Error("Not confirmed."); } }; },
    input: Readable.from([`${command}\n`, "NO\n", "/moa duo alpha alpha --aggregate gamma -- Inspect\n", "/exit\n"]),
    write: (text) => output.push(text),
  });
  assert.deepEqual(sent, []);
  assert.match(output.join(""), /Type SHARE to confirm/);
  assert.match(output.join(""), /not confirmed/);
  assert.match(output.join(""), /Usage: \/moa/);
});

test("CLI MoA selects profile models, fresh provider instances and no interactive session continuation", async () => {
  const created: string[] = [];
  const requests: string[] = [];
  const output: string[] = [];
  await main([], { providerRegistry: registry(), config: { provider: "alpha", models: { alpha: "alpha-configured", beta: "beta-configured", gamma: "gamma-configured" } }, tools: [],
    modelFactory: (id, model) => {
      created.push(`${id}:${model}`);
      return { async respond(request) {
        requests.push(`${id}:${request.task}`);
        assert.equal(request.conversationResponseId, undefined);
        assert.deepEqual(request.tools, []);
        return { responseId: id, text: id === "gamma" ? "Synthesized answer." : `${id} report`, toolCalls: [] };
      } };
    },
    input: Readable.from([`${command}\n`, "SHARE\n", "/exit\n"]),
    write: (text) => output.push(text),
  });
  assert.deepEqual(created, ["alpha:alpha-configured", "beta:beta-configured", "gamma:gamma-configured"]);
  assert.equal(requests.length, 3);
  assert.match(requests[2]!, /alpha report/);
  assert.match(requests[2]!, /beta report/);
  assert.match(output.join(""), /Synthesized answer\./);
});

test("CLI MoA filters WRITE tools and does not synthesize after candidate failure", async () => {
  const created: string[] = [];
  const output: string[] = [];
  await main([], { providerRegistry: registry(), config: { provider: "alpha", model: "shared-model" },
    tools: [{ name: "unsafe_write", description: "fixture", operation: "WRITE", inputSchema: { type: "object" },
      execute: async () => { throw new Error("Must not run."); } }],
    modelFactory: (id, model) => {
      created.push(`${id}:${model}`);
      return { async respond(request) {
        assert.deepEqual(request.tools, []);
        if (id === "alpha") throw new Error("Candidate failed.");
        return { responseId: id, text: "Candidate", toolCalls: [] };
      } };
    },
    input: Readable.from([`${command}\n`, "SHARE\n", "/exit\n"]), write: (text) => output.push(text),
  });
  assert.ok(created.includes("alpha:shared-model"));
  assert.ok(!created.some((value) => value.startsWith("gamma:")));
  assert.match(output.join(""), /MoA failed or was cancelled/);
  assert.doesNotMatch(output.join(""), /Candidate failed/);
});
