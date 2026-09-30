import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "../../dist/agent.js";
import { main, parseCliCommand } from "../../dist/cli.js";
import { createFileCronTaskStore } from "../../dist/cron-store.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";

function parse(arguments_: string[]) { return parseCliCommand(arguments_); }

test("cron CLI accepts only explicit bounded command shapes", () => {
  assert.deepEqual(parse(["cron", "add", "*/15 * * * *", "Read project."]), { kind: "cron", action: "add", expression: "*/15 * * * *", prompt: "Read project." });
  assert.deepEqual(parse(["cron", "once", "2027-01-01T00:00:00.000Z", "Read.", "--skill", "project", "review"]), {
    kind: "cron", action: "once", expression: "2027-01-01T00:00:00.000Z", prompt: "Read.", skill: { scope: "PROJECT", id: "review" },
  });
  for (const args of [["cron"], ["cron", "add", "* * * * *"], ["cron", "add", "* * * * *", "Read", "--skill", "user"], ["cron", "serve", "extra"], ["cron", "list", "extra"]]) {
    assert.throws(() => parse(args), /Use dragons cron/);
  }
});

test("cron CLI isolates profile and workspace records and pins project skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-cli-"));
  const workspace = join(root, "workspace");
  const other = join(root, "other");
  const messages: string[] = [];
  try {
    await mkdir(workspace);
    await mkdir(other);
    const projectSkill = join(workspace, ".dragons", "skills", "review");
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, "SKILL.md"), "---\nname: Review\ndescription: Read safely.\n---\nRead only.\n");
    const profiles = createDragonsProfileStore({ configPath: join(root, "config.json") });
    const base = { profileStore: profiles, configPath: join(root, "config.json"), workingDirectory: workspace, cronDirectory: join(root, "cron"), skillsDirectory: join(root, "skills"), write: (text: string) => { messages.push(text); } };
    await main(["cron", "add", "*/15 * * * *", "Read project.", "--skill", "project", "review"], base);
    const id = messages[0]?.match(/[0-9a-f-]{36}/)?.[0];
    assert.ok(id);
    const canonical = await realpath(workspace);
    const store = createFileCronTaskStore(join(base.cronDirectory, createHash("sha256").update(canonical).digest("hex")));
    assert.match((await store.load(id))?.skill?.digest ?? "", /^[a-f0-9]{64}$/);
    await writeFile(join(projectSkill, "SKILL.md"), "---\nname: Review\ndescription: Read safely.\n---\nChanged text.\n");
    await assert.rejects(main(["cron", "trigger", id], { ...base, modelFactory: () => { throw new Error("Model must not start."); } }), /pinned skill is missing, changed or invalid/);
    messages.length = 0;
    await main(["cron", "list"], base);
    assert.match(messages.join(""), new RegExp(id));
    assert.doesNotMatch(messages.join(""), /Read project/);
    messages.length = 0;
    await main(["cron", "list"], { ...base, workingDirectory: other });
    assert.deepEqual(messages, []);
    await assert.rejects(main(["cron", "pause", id], { ...base, workingDirectory: other }), /not found/i);
    await main(["cron", "pause", id], base);
    await main(["cron", "resume", id], base);
    await main(["cron", "remove", id], base);
    messages.length = 0;
    await main(["cron", "list"], base);
    assert.deepEqual(messages, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("foreground cron service executes a due read-only job and shuts down on host signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-serve-"));
  const workspace = join(root, "workspace");
  const cronDirectory = join(root, "cron");
  const controller = new AbortController();
  const messages: string[] = [];
  let modelCalls = 0;
  try {
    await mkdir(workspace);
    const profileStore = createDragonsProfileStore({ configPath: join(root, "config.json") });
    const options = { profileStore, configPath: join(root, "config.json"), workingDirectory: workspace, cronDirectory,
      skillsDirectory: join(root, "skills"), cronSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]),
      modelFactory: (): AgentModel => ({ async respond(request) {
        modelCalls += 1;
        assert.ok(request.tools.every((tool) => tool.operation === "READ"));
        return { responseId: "done", text: "checked", toolCalls: [] };
      } }),
      write: (text: string) => { messages.push(text); if (text.includes(": checked")) controller.abort(); },
    };
    await main(["cron", "add", "* * * * *", "Read status."], options);
    const id = messages[0]?.match(/[0-9a-f-]{36}/)?.[0];
    assert.ok(id);
    const canonical = await realpath(workspace);
    const store = createFileCronTaskStore(join(cronDirectory, createHash("sha256").update(canonical).digest("hex")));
    const record = await store.load(id);
    assert.ok(record);
    await store.save({ ...record, nextRunAt: new Date(Date.now() - 60_000).toISOString() }, record.revision);
    await main(["cron", "serve"], options);
    assert.equal(modelCalls, 1);
    assert.ok(messages.some((text) => text.includes(`${id}: checked`)));
    assert.equal((await store.load(id))?.state, "active");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pinned cron service reads its named profile after the active profile changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-profile-"));
  const workspace = join(root, "workspace");
  const controller = new AbortController();
  const messages: string[] = [];
  try {
    await mkdir(workspace);
    const configPath = join(root, "config.json");
    const profiles = createDragonsProfileStore({ configPath });
    await profiles.create("review");
    await profiles.select("review");
    const options = { profileStore: profiles, configPath, workingDirectory: workspace,
      cronSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]),
      modelFactory: (): AgentModel => ({ async respond() {
        return { responseId: "done", text: "reviewed", toolCalls: [] };
      } }), write: (text: string) => { messages.push(text); if (text.includes(": reviewed")) controller.abort(); } };
    await main(["cron", "add", "* * * * *", "Review workspace."], options);
    const id = messages[0]?.match(/[0-9a-f-]{36}/)?.[0];
    assert.ok(id);
    const canonical = await realpath(workspace);
    const store = createFileCronTaskStore(join(root, "profiles", "review", "cron", createHash("sha256").update(canonical).digest("hex")));
    const record = await store.load(id);
    assert.ok(record);
    await store.save({ ...record, nextRunAt: new Date(Date.now() - 60_000).toISOString() }, record.revision);
    await profiles.select("default");
    await mkdir(join(root, "other"));
    await assert.rejects(main(["cron", "serve", "--profile", "review", "--workspace", join(root, "other")], options), /cannot override the host workspace/);
    await main(["cron", "serve", "--profile", "review", "--workspace", workspace], options);
    assert.equal(await profiles.active(), "default");
    assert.ok(messages.some((text) => text.includes(`${id}: reviewed`)));
    await assert.rejects(main(["cron", "serve", "--profile", "missing"], options), /does not exist/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("foreground cron startup reports a failed job and still runs the next due job", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-serve-failure-"));
  const workspace = join(root, "workspace");
  const cronDirectory = join(root, "cron");
  const controller = new AbortController();
  const messages: string[] = [];
  let modelCalls = 0;
  try {
    await mkdir(workspace);
    const options = {
      profileStore: createDragonsProfileStore({ configPath: join(root, "config.json") }),
      configPath: join(root, "config.json"), workingDirectory: workspace, cronDirectory,
      skillsDirectory: join(root, "skills"), cronSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]),
      modelFactory: (): AgentModel => ({ async respond() {
        modelCalls += 1;
        if (modelCalls === 1) throw new Error("private provider failure");
        return { responseId: "done", text: "checked", toolCalls: [] };
      } }),
      write: (text: string) => { messages.push(text); if (text.includes(": checked")) controller.abort(); },
    };
    await main(["cron", "add", "* * * * *", "First."], options);
    await main(["cron", "add", "* * * * *", "Second."], options);
    const canonical = await realpath(workspace);
    const store = createFileCronTaskStore(join(cronDirectory, createHash("sha256").update(canonical).digest("hex")));
    for (const task of await store.list()) await store.save({ ...task, nextRunAt: new Date(Date.now() - 60_000).toISOString() }, task.revision);
    await main(["cron", "serve"], options);
    assert.equal(modelCalls, 2);
    assert.equal(messages.filter((text) => text.includes("Cron run failed")).length, 1);
    assert.ok(messages.some((text) => text.includes(": checked")));
    assert.doesNotMatch(messages.join(""), /private provider failure/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
