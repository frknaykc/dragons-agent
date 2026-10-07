import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRequest } from "../../dist/agent.js";
import { createReadOnlyCronRunner } from "../../dist/cron-runner.js";
import { CronScheduler, type CronTask } from "../../dist/cron-scheduler.js";
import { createFileCronTaskStore } from "../../dist/cron-store.js";
import { getProjectSkillsDirectory, listProjectSkills } from "../../dist/skills.js";

const ID = "11111111-1111-4111-8111-111111111111";
function task(workingDirectory: string): CronTask {
  return { version: 1, id: ID, workingDirectory, prompt: "Read status.", schedule: { kind: "once", at: "2027-01-01T00:00:00.000Z" }, state: "finished", revision: 1 };
}

test("scheduled runner exposes only built-in read tools and never grants unattended write or execute", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-cron-runner-"));
  try {
    await writeFile(join(workspace, "status.txt"), "ready");
    const requests: AgentRequest[] = [];
    const reports: string[] = [];
    const run = createReadOnlyCronRunner({
      workingDirectory: workspace,
      createModel: () => ({
        async respond(request) {
          requests.push(request);
          if (request.toolOutputs.length === 0) return { responseId: "r1", text: "", toolCalls: [
            { callId: "read", name: "read_file", arguments: '{"path":"status.txt"}' },
            { callId: "write", name: "write_file", arguments: '{"path":"status.txt","content":"changed"}' },
            { callId: "exec", name: "shell", arguments: '{"command":"whoami"}' },
          ] };
          return { responseId: "r2", text: "done", toolCalls: [] };
        },
      }),
      onReport: (_id, report) => { reports.push(report); },
    });
    await run(task(workspace), new AbortController().signal);
    assert.equal(requests.length, 2);
    assert.ok(requests[0]!.tools.length > 0);
    assert.ok(requests[0]!.tools.every((tool) => tool.operation === "READ"));
    assert.ok(requests[1]!.toolOutputs.some((output) => output.callId === "read" && output.output.includes("ready")));
    assert.ok(requests[1]!.toolOutputs.some((output) => output.callId === "write" && !output.output.includes("changed")));
    assert.ok(requests[1]!.toolOutputs.some((output) => output.callId === "exec" && !output.output.includes("whoami")));
    assert.deepEqual(reports, ["done"]);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("scheduled runner refuses cross-workspace records, unbound skills and pre-cancelled work", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-cron-runner-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "dragons-cron-elsewhere-"));
  let created = 0;
  try {
    const run = createReadOnlyCronRunner({ workingDirectory: workspace, createModel: () => { created += 1; return { async respond() { return { responseId: "r1", text: "", toolCalls: [] }; } }; } });
    await assert.rejects(run(task(elsewhere), new AbortController().signal), /workspace does not match/i);
    await assert.rejects(run({ ...task(workspace), skillId: "quick-notes" }, new AbortController().signal), /unpinned cron skill binding/i);
    const controller = new AbortController();
    controller.abort();
    await run(task(workspace), controller.signal);
    assert.equal(created, 0);
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(elsewhere, { recursive: true, force: true }); }
});

test("scheduled runner resolves a pinned project skill, then refuses drift before model creation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-cron-skill-"));
  let created = 0;
  try {
    const root = await getProjectSkillsDirectory(workspace);
    await mkdir(join(root, "review"), { recursive: true });
    const path = join(root, "review", "SKILL.md");
    await writeFile(path, "---\nname: Review\ndescription: Inspect changes.\n---\nRead only.\n");
    const [skill] = await listProjectSkills(workspace);
    assert.ok(skill);
    const pinned: CronTask = { ...task(workspace), skill: { id: skill.id, scope: "PROJECT", digest: skill.digest } };
    const run = createReadOnlyCronRunner({ workingDirectory: workspace, createModel: () => {
      created += 1;
      return { async respond(request) {
        assert.equal(request.skills?.skills[0]?.digest, skill.digest);
        assert.equal(request.skills?.skills[0]?.scope, "PROJECT");
        return { responseId: "done", text: "ok", toolCalls: [] };
      } };
    } });
    await run(pinned, new AbortController().signal);
    assert.equal(created, 1);
    await writeFile(path, "---\nname: Review\ndescription: Inspect changes.\n---\nChanged guidance.\n");
    await assert.rejects(run(pinned, new AbortController().signal), /pinned skill is missing, changed or invalid/i);
    assert.equal(created, 1);
    await assert.rejects(run({ ...task(workspace), skill: { id: "review", scope: "PROJECT", digest: "oops" } }, new AbortController().signal), /invalid cron skill binding/i);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("a timed-out model is cancelled and reported while the next due cron task still runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workspace = await mkdtemp(join(tmpdir(), "dragons-cron-runner-"));
  const ids = [ID, "22222222-2222-4222-8222-222222222222"];
  const reports: string[] = [];
  const errors: string[] = [];
  let aborted = false;
  let entered!: () => void;
  const modelEntered = new Promise<void>((resolve) => { entered = resolve; });
  let now = new Date("2026-09-25T11:14:00.000Z");
  try {
    const run = createReadOnlyCronRunner({ workingDirectory: workspace, maxRunMs: 250,
      createModel: () => ({ async respond(request) {
        if (request.task === "Hang.") {
          entered();
          await new Promise<void>((_resolve, reject) => {
            const cancel = () => { aborted = true; reject(new Error("provider aborted")); };
            request.signal?.addEventListener("abort", cancel, { once: true });
            if (request.signal?.aborted) cancel();
          });
        }
        return { responseId: "done", text: "ok", toolCalls: [] };
      } }), onReport: (id) => { reports.push(id); },
    });
    const scheduler = new CronScheduler({ store: createFileCronTaskStore(workspace), run,
      now: () => now, createId: () => ids.shift()! });
    for (const prompt of ["Hang.", "Continue."]) await scheduler.create({
      workingDirectory: workspace, prompt, schedule: { kind: "cron", expression: "* * * * *" },
    });
    now = new Date("2026-09-25T11:15:00.000Z");
    const tick = scheduler.tick((error) => errors.push((error as Error).message));
    await modelEntered;
    assert.equal(aborted, false, "the model was actually running before its deadline");
    t.mock.timers.tick(250);
    assert.equal(await tick, 1);
    assert.equal(aborted, true);
    assert.deepEqual(errors, ["Cron run timed out."]);
    assert.deepEqual(reports, ["22222222-2222-4222-8222-222222222222"]);
    assert.equal(await scheduler.tick(), 0, "failed reserved slots do not replay");
  } finally { t.mock.timers.reset(); await rm(workspace, { recursive: true, force: true }); }
});

test("host shutdown cancels cron without a timeout report or a late model result", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-cron-runner-"));
  const controller = new AbortController();
  const reports: string[] = [];
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  try {
    assert.throws(() => createReadOnlyCronRunner({ workingDirectory: workspace, maxRunMs: 0,
      createModel: () => { throw new Error("must not create"); } }), /deadline/i);
    const run = createReadOnlyCronRunner({ workingDirectory: workspace, maxRunMs: 10_000,
      createModel: () => ({ async respond(request) {
        started();
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
          if (request.signal?.aborted) resolve();
        });
        return { responseId: "late", text: "late", toolCalls: [] };
      } }), onReport: (_id, report) => reports.push(report),
    });
    const pending = run(task(workspace), controller.signal);
    await entered;
    controller.abort();
    await assert.rejects(pending, /cancel/i);
    assert.deepEqual(reports, []);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
