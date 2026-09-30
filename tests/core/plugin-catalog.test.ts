import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReviewedPluginCatalog } from "../../dist/plugin-catalog.js";
import { PluginRegistry } from "../../dist/plugins.js";
import { runAgent } from "../../dist/agent.js";
import type { AgentModel } from "../../dist/agent.js";

const withRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "dragons-catalog-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test("reviewed catalog installs, upgrades, activates trusted factory under authorization, then removes", async () => {
  await withRoot(async (root) => {
    const catalog = new ReviewedPluginCatalog(join(root, "plugins"));
    assert.deepEqual(catalog.list().map(({ version }) => version), ["1.0.0", "1.1.0"]);
    assert.deepEqual(await catalog.listInstalled(), []);
    assert.equal((await catalog.install("hello", "1.0.0")).version, "1.0.0");
    await assert.rejects(catalog.install("hello", "1.1.0"), /EEXIST/);
    assert.equal((await catalog.update("hello", "1.1.0")).version, "1.1.0");
    assert.equal((await catalog.update("hello", "1.1.0")).version, "1.1.0");
    await assert.rejects(catalog.update("hello", "1.0.0"), /cannot downgrade/);
    assert.deepEqual((await catalog.listInstalled()).map(({ version }) => version), ["1.1.0"]);
    const registry = new PluginRegistry();
    await catalog.activate("hello", registry);
    const tool = registry.tools()[0];
    assert.equal(tool.name, "plugin_hello_greet");
    assert.equal(tool.operation, "EXECUTE");
    const model: AgentModel = { async respond(input) {
      if (input.toolOutputs.length === 0) return { responseId: "first", text: "", toolCalls: [{ callId: "g", name: "plugin_hello_greet", arguments: '{"name":"Ada"}' }] };
      assert.equal(input.toolOutputs[0]?.output, "Hello, Ada!");
      return { responseId: "second", text: "done", toolCalls: [] };
    } };
    let approvals = 0;
    const result = await runAgent({ task: "greet", model, tools: [tool], authorize(request) {
      approvals++;
      assert.equal(request.operation, "EXECUTE");
      return true;
    } });
    assert.equal(result.finalText, "done");
    assert.equal(approvals, 1);
    await catalog.remove("hello");
    assert.deepEqual(await catalog.listInstalled(), []);
    await assert.rejects(catalog.activate("hello", new PluginRegistry()), /ENOENT/);
  });
});

test("catalog refuses unknown, tampered, linked or foreign installs without deleting data", async () => {
  await withRoot(async (root) => {
    const path = join(root, "plugins");
    const catalog = new ReviewedPluginCatalog(path);
    await assert.rejects(catalog.install("../bad", "1.0.0"), /not in the reviewed catalog/);
    await catalog.install("hello", "1.0.0");
    const file = join(path, "hello", "plugin.json");
    const original = await readFile(file);
    await writeFile(file, "unreviewed\n");
    for (const operation of [() => catalog.listInstalled(), () => catalog.update("hello", "1.1.0"), () => catalog.remove("hello"), () => catalog.activate("hello", new PluginRegistry())]) {
      await assert.rejects(operation());
    }
    assert.equal(await readFile(file, "utf8"), "unreviewed\n");
    await writeFile(file, original);
    const extra = join(path, "hello", "user.txt");
    await writeFile(extra, "keep");
    await assert.rejects(catalog.update("hello", "1.1.0"), /other files/);
    await assert.rejects(catalog.remove("hello"), /other files/);
    assert.equal(await readFile(extra, "utf8"), "keep");
    await unlink(extra);
    const outside = join(root, "outside");
    await writeFile(outside, original);
    await unlink(file);
    await link(outside, file);
    await assert.rejects(catalog.remove("hello"), /unlinked regular file/);
    await unlink(file);
    await symlink(outside, file);
    await assert.rejects(catalog.update("hello", "1.1.0"), /unlinked regular file/);
    assert.deepEqual(await readFile(outside), original);
  });
});

test("catalog refuses to adopt a symlinked installation directory", async () => {
  await withRoot(async (root) => {
    const path = join(root, "plugins");
    const catalog = new ReviewedPluginCatalog(path);
    await catalog.listInstalled();
    const outside = join(root, "elsewhere");
    await writeFile(outside, "keep");
    await symlink(root, join(path, "hello"), "dir");
    await assert.rejects(catalog.install("hello", "1.0.0"), /EEXIST/);
    await assert.rejects(catalog.remove("hello"), /real directory/);
    assert.equal(await readFile(outside, "utf8"), "keep");
  });
});
