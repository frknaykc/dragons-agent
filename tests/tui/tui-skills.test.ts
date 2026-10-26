import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleInteractiveSkillsCommand } from "../../dist/cli/skills-commands.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";
import { createSessionStore } from "../../dist/session-store.js";
import { activateSkill } from "../../dist/skills.js";
import { createTuiLocalCommands } from "../../dist/tui/local-commands.js";

for (const action of ["activate", "deactivate"] as const) test(`cancelled skills ${action} cannot mutate a queued session`, { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-tui-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "skills");
  await mkdir(join(directory, "fixture"), { recursive: true });
  await writeFile(join(directory, "fixture", "SKILL.md"), "---\nname: Fixture\ndescription: Cancellation fixture\n---\nAdvisory instructions.\n");
  const store = createSessionStore(join(root, "sessions"), { providerIds: ["fixture"] });
  const session = await store.create({ provider: "fixture", model: "fixture-1", workingDirectory: root });
  session.skills = action === "deactivate" ? await activateSkill(directory, [], "fixture") : [];
  await store.save(session);
  const controller = new AbortController();
  let entered!: () => void;
  const queued = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = handleInteractiveSkillsCommand({
    task: `/skills ${action} fixture`, directory, workingDirectory: root,
    session, activeSkillReferences: session.skills, signal: controller.signal, write: () => {},
    sessionStore: { ...store, async mutate(id, update) { entered(); await gate; return store.mutate!(id, update); } },
  });
  await queued;
  controller.abort();
  release();
  await pending;
  assert.deepEqual((await store.load(session.id))!.skills, session.skills);
});

test("TUI skills is host-opt-in, receives the current session and suppresses cancelled output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-tui-skills-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = {
    auth: { async login() {}, async logout() {}, async status() { return { authenticated: false }; } },
    profiles: createDragonsProfileStore({ configPath: join(root, "config.json") }),
    sessions: createSessionStore(join(root, "sessions")),
  };

  assert.equal(createTuiLocalCommands(base).names.includes("/skills"), false);
  const controller = new AbortController();
  let called = false;
  const commands = createTuiLocalCommands({ ...base, skills: async (command, id, signal) => {
    assert.equal(command, "/skills list"); assert.equal(id, "current-session");
    assert.equal(signal, controller.signal); called = true; controller.abort(); return "late output";
  } });
  const notices: string[] = [];
  await commands.execute("/skills list", { signal: controller.signal, notice: (text) => notices.push(text) });
  assert.equal(called, false);
  assert.deepEqual(notices, ["Create a session first."]);
  notices.length = 0;
  await commands.execute("/skills list", { signal: controller.signal,
    session: { id: "current-session", provider: "fixture", model: "fixture-1" }, notice: (text) => notices.push(text),
  });
  assert.equal(called, true);
  assert.deepEqual(notices, []);
});
