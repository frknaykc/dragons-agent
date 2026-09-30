import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";
import { SkillCurator } from "../../dist/skill-curator.js";
import { activateSkill } from "../../dist/skills.js";

test("runtime opt-in curator tracks only committed runs with actually resolved skills and cannot fail a saved conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-curator-"));
  const skills = join(root, "skills");
  await mkdir(join(skills, "note"), { recursive: true });
  await writeFile(join(skills, "note", "SKILL.md"), "---\nname: Note\ndescription: Notes.\n---\nBe concise.\n");
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond() { return { responseId: "r", text: "done", toolCalls: [] }; } }),
  }]);
  const store = createSessionStore(join(root, "sessions"), { providerIds: providers.ids() });
  const curator = new SkillCurator(join(root, "curator"));
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers, sessionStore: store,
    tools: [], memoryDirectory: join(root, "memory"), skillsDirectory: skills, skillCurator: curator,
  });
  try {
    const session = await runtime.createSession();
    const active = await activateSkill(skills, [], "note");
    const current = await store.load(session.id);
    assert.ok(current);
    await store.save({ ...current, skills: active });
    const first = await runtime.sendUserInput({ sessionId: session.id, content: "first" });
    for await (const _ of first.events) { /* drain */ }
    assert.equal((await first.result).finalText, "done");
    assert.equal((await curator.usage())[0]?.count, 1);
    await writeFile(join(skills, "note", "SKILL.md"), "---\nname: Note\ndescription: Notes.\n---\nChanged.\n");
    const second = await runtime.sendUserInput({ sessionId: session.id, content: "second" });
    for await (const _ of second.events) { /* drain */ }
    assert.equal((await second.result).finalText, "done");
    assert.equal((await curator.usage())[0]?.count, 1);
    await writeFile(join(root, "curator", "skill-curator.json"), "invalid-json");
    const updated = await store.load(session.id);
    assert.ok(updated);
    await store.save({ ...updated, skills: await activateSkill(skills, active, "note") });
    const third = await runtime.sendUserInput({ sessionId: session.id, content: "third" });
    for await (const _ of third.events) { /* drain */ }
    assert.equal((await third.result).finalText, "done");
    assert.equal(await readFile(join(root, "curator", "skill-curator.json"), "utf8"), "invalid-json");
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});