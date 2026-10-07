import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { main } from "../../dist/cli.js";
import { parseKanbanWorkerLane, parseKanbanWorkerStart, parseInteractiveKanbanCommand } from "../../dist/cli/kanban-commands.js";
import { createFileKanbanBoard, inspectKanbanLaneLock, inspectKanbanLock,
  kanbanWorkspaceDirectory } from "../../dist/kanban.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";

test("Kanban slash parser rejects extra arguments, unsafe titles and malformed revisions", () => {
  assert.deepEqual(parseInteractiveKanbanCommand("/kanban"), { action: "list" });
  assert.deepEqual(parseInteractiveKanbanCommand("/kanban add beta -- Review patch"), { action: "add", assignee: "beta", title: "Review patch" });
  for (const input of ["/kanban list extra", "/kanban add beta -- ", "/kanban add beta -- injected\u001b[31m",
    "/kanban assign x -1 beta", "/kanban progress x 0 doing 101", "/kanban progress x 0 done 1",
    "/kanban depend x 0", "/kanban unknown", "/kanban worker recover x 0 42",
    `/kanban worker recover ${randomUUID()} 0 0`, `/kanban worker recover ${randomUUID()} 0 -1`,
    `/kanban worker recover ${randomUUID()} 0 42 extra`]) assert.equal(parseInteractiveKanbanCommand(input), undefined);
});

test("worker start parser rejects extra fields and never enters ordinary board commands", () => {
  const id = randomUUID();
  assert.deepEqual(parseKanbanWorkerStart(`/kanban worker start ${id} 0`), { id, revision: 0 });
  assert.equal(parseInteractiveKanbanCommand(`/kanban worker start ${id} 0`), undefined);
  for (const input of [`/kanban worker start ${id} -1`, `/kanban worker start ${id} 0 extra`,
    `/kanban worker start ${id} 00`, "/kanban worker start missing 0"])
    assert.equal(parseKanbanWorkerStart(input), undefined);
});

test("worker lane parser accepts only a bounded explicit list of unique task revisions", () => {
  const id = randomUUID();
  const next = randomUUID();
  assert.deepEqual(parseKanbanWorkerLane(`/kanban worker lane ${id}:0 ${next}:5`), [
    { id, revision: 0 }, { id: next, revision: 5 },
  ]);
  for (const input of ["/kanban worker lane", `/kanban worker lane ${id}:00`,
    `/kanban worker lane ${id}:-1`, `/kanban worker lane ${id}:9999999999`,
    `/kanban worker lane ${id}:0 ${id}:1`, `/kanban worker lane ${id}:0 extra`,
    `/kanban worker lane ${id}:0;echo`, `/kanban worker lane ${Array.from({ length: 9 }, () => `${randomUUID()}:0`).join(" ")}`])
    assert.equal(parseKanbanWorkerLane(input), undefined);
  assert.equal(parseInteractiveKanbanCommand(`/kanban worker lane ${id}:0`), undefined);
});

test("CLI launches an explicitly selected Local worker without granting the interactive model tools", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-cli-kanban-start-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.create("beta");
  await profiles.select("alpha");
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, root), profiles);
  const task = await board.create("alpha", "Read the project", "alpha", []);
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(`${request.url} ${request.headers.authorization ?? "no-auth"}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk as Uint8Array);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
    requests.push(input.messages.at(-1)?.content ?? "no-message");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"id":"worker-test","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(profiles.paths("alpha").configPath, JSON.stringify({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }));
  const run = async (actor: string, lines: string[]) => {
    await profiles.select(actor);
    const output: string[] = [];
    await main([], {
      input: PassThrough.from([...lines.map((line) => `${line}\n`), "/exit\n"]),
      write: (text) => output.push(text), workingDirectory: root, configPath, profileStore: profiles, tools: [],
      model: { async respond() { throw new Error("Worker slash command reached interactive model."); } },
    });
    return output.join("");
  };
  assert.match(await run("beta", [`/kanban worker start ${task.id} 0`]), /worker failed/);
  assert.equal((await board.get("alpha", task.id))?.status, "todo");
  assert.match(await run("alpha", [`/kanban worker start ${task.id} 0 extra`]), /Usage: \/kanban worker start/);
  const started = await run("alpha", [`/kanban worker start ${task.id} 0`]);
  assert.match(started, /worker completed task/, JSON.stringify({ task: await board.get("alpha", task.id), requests }));
  assert.deepEqual(requests, ["/v1/chat/completions no-auth", task.title]);
  assert.equal((await board.get("alpha", task.id))?.status, "done");
  assert.match(await run("alpha", [`/kanban worker start ${task.id} 0`]), /worker failed/);
});

test("CLI lane runs selected dependent Local tasks in order without replay or interactive model access", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-cli-kanban-lane-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.create("beta");
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, root), profiles);
  const first = await board.create("alpha", "First", "alpha", []);
  const second = await board.create("alpha", "Second", "alpha", []);
  const dependent = await board.addDependency("alpha", second.id, 0, first.id);
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk as Uint8Array);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
    requests.push(input.messages.at(-1)?.content ?? "missing");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"id":"lane-cli","choices":[{"index":0,"delta":{"content":"PRIVATE RESPONSE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(profiles.paths("alpha").configPath, JSON.stringify({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }));
  const run = async (actor: string, command: string): Promise<string> => {
    await profiles.select(actor);
    const output: string[] = [];
    await main([], { input: PassThrough.from([`${command}\n`, "/exit\n"]),
      write: (text) => output.push(text), workingDirectory: root, configPath, profileStore: profiles,
      tools: [], model: { async respond() { throw new Error("Lane command reached interactive model."); } },
    });
    return output.join("");
  };
  const lane = (items: string) => `/kanban worker lane ${items}`;
  assert.match(await run("alpha", lane(`${second.id}:${dependent.revision} ${first.id}:0`)), /lane.*(?:stale|ready|failed)/i);
  assert.match(await run("alpha", lane(`${first.id}:0 ${first.id}:0`)), /Usage: \/kanban worker lane/);
  assert.match(await run("alpha", lane(`${first.id}:00`)), /Usage: \/kanban worker lane/);
  assert.match(await run("beta", lane(`${first.id}:0 ${second.id}:${dependent.revision}`)), /lane.*(?:stale|failed)/i);
  assert.equal(requests.length, 0);
  const result = await run("alpha", lane(`${first.id}:0 ${second.id}:${dependent.revision}`));
  assert.match(result, /Kanban worker lane completed 2 tasks/);
  assert.doesNotMatch(result, /PRIVATE RESPONSE|lane-cli/);
  assert.deepEqual(requests, ["First", "Second"]);
  assert.equal((await board.get("alpha", first.id))?.status, "done");
  assert.equal((await board.get("alpha", second.id))?.status, "done");
  assert.match(await run("alpha", lane(`${first.id}:0 ${second.id}:${dependent.revision}`)), /lane.*(?:stale|failed)/i);
  assert.equal(requests.length, 2);
});

test("interactive Kanban shares one workspace board between profiles without sending slash commands to the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-kanban-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.create("beta");
  let modelCalls = 0;
  const registry = createProviderRegistry([{
    id: "local", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond() { modelCalls++; throw new Error("Slash command reached model."); } }),
  }]);
  const run = async (lines: string[]): Promise<string> => {
    const output: string[] = [];
    await main(["--provider", "local"], {
      input: PassThrough.from([...lines.map((line) => `${line}\n`), "/exit\n"]),
      write: (text) => output.push(text), workingDirectory: workspace, configPath,
      profileStore: profiles, providerRegistry: registry, tools: [],
    });
    return output.join("");
  };
  await profiles.select("alpha");
  const created = await run(["/kanban add alpha -- Prepare", "/kanban add beta -- Ship"]);
  const matches = [...created.matchAll(/Kanban task created: ([0-9a-f-]{36})/g)];
  assert.equal(matches.length, 2, created);
  const prerequisiteId = matches[0]![1]!;
  const taskId = matches[1]![1]!;
  assert.match(await run([`/kanban depend ${taskId} 0 ${prerequisiteId}`]), /revision 1/);
  await profiles.select("beta");
  const blocked = await run(["/kanban list", `/kanban progress ${taskId} 1 doing 25`, `/kanban assign ${taskId} 1 alpha`]);
  assert.match(blocked, /Prepare/);
  assert.match(blocked, /Ship/);
  assert.match(blocked, /Kanban command failed/);
  await profiles.select("alpha");
  assert.match(await run([`/kanban progress ${prerequisiteId} 0 done 100`]), /revision 1/);
  await profiles.select("beta");
  assert.match(await run([`/kanban progress ${taskId} 1 doing 25`]), /revision 2/);
  await profiles.select("alpha");
  assert.match(await run([`/kanban assign ${taskId} 2 alpha`]), /Only an idle Kanban task/);
  await profiles.select("beta");
  assert.match(await run([`/kanban progress ${taskId} 2 done 100`]), /revision 3/);
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, workspace), profiles);
  assert.equal((await board.get("alpha", taskId))?.status, "done");
  assert.equal((await board.get("beta", taskId))?.createdBy, "alpha");
  assert.equal(modelCalls, 0);
});

test("interactive Kanban lock inspection hides token and recovery requires typed confirmation for this workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-kanban-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.select("alpha");
  const directory = kanbanWorkspaceDirectory(configPath, workspace);
  await createFileKanbanBoard(directory, profiles).create("alpha", "First", "alpha", []);
  const token = randomUUID();
  const lockPath = join(directory, ".kanban.lock");
  const lock = (pid: number) => writeFile(lockPath, JSON.stringify({ pid, host: hostname(), token }));
  const run = async (lines: string[]): Promise<string> => {
    const output: string[] = [];
    await main([], {
      input: PassThrough.from([...lines.map((line) => `${line}\n`), "/exit\n"]),
      write: (text) => output.push(text), workingDirectory: workspace, configPath,
      profileStore: profiles, tools: [],
      model: { async respond() { throw new Error("Lock command reached model."); } },
    });
    return output.join("");
  };
  await lock(999999999);
  const status = await run(["/kanban lock status"]);
  assert.match(status, /No recovery attempted/);
  assert.doesNotMatch(status, new RegExp(token));
  assert.match(await run(["/kanban lock recover", "NO"]), /not confirmed/);
  assert.ok(await inspectKanbanLock(directory));
  await lock(process.pid);
  assert.match(await run(["/kanban lock recover", "RECOVER"]), /still active/);
  assert.ok(await inspectKanbanLock(directory));
  await lock(999999999);
  const recovered = await run(["/kanban lock recover", "RECOVER"]);
  assert.match(recovered, /Abandoned Kanban lock removed/);
  assert.doesNotMatch(recovered, new RegExp(token));
  assert.equal(await inspectKanbanLock(directory), undefined);
});

test("CLI lane lock recovery is explicit, token-hidden and separate from board locks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-kanban-lane-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.select("alpha");
  const directory = kanbanWorkspaceDirectory(configPath, workspace);
  await createFileKanbanBoard(directory, profiles).create("alpha", "First", "alpha", []);
  const lockPath = join(directory, ".kanban-lane.lock");
  const token = randomUUID();
  const lock = (pid: number, host = hostname(), value = token) =>
    writeFile(lockPath, JSON.stringify({ pid, host, token: value }));
  const run = async (lines: string[]): Promise<string> => {
    const output: string[] = [];
    await main([], {
      input: PassThrough.from([...lines.map((line) => `${line}\n`), "/exit\n"]),
      write: (text) => output.push(text), workingDirectory: workspace, configPath,
      profileStore: profiles, tools: [],
      model: { async respond() { throw new Error("Lane lock commands reached the model."); } },
    });
    return output.join("");
  };
  assert.match(await run(["/kanban lane lock status"]), /No Kanban lane lock/);
  await lock(999999999);
  const status = await run(["/kanban lane lock status", "/kanban lane lock extra"]);
  assert.match(status, /PID 999999999/);
  assert.match(status, /Usage: \/kanban lane lock status/);
  assert.doesNotMatch(status, new RegExp(token));
  assert.match(await run(["/kanban lane lock recover", "NO"]), /not confirmed/i);
  assert.ok(await inspectKanbanLaneLock(directory));
  await lock(process.pid);
  assert.match(await run(["/kanban lane lock recover", "RECOVER"]), /still active/i);
  await lock(999999999, "other-host");
  assert.match(await run(["/kanban lane lock recover", "RECOVER"]), /another host/i);
  await lock(999999999);
  const recovered = await run(["/kanban lane lock recover", "RECOVER"]);
  assert.match(recovered, /Abandoned Kanban lane lock removed/);
  assert.doesNotMatch(recovered, new RegExp(token));
  assert.equal(await inspectKanbanLaneLock(directory), undefined);
  assert.match(await run(["/kanban lock status"]), /No Kanban lock/);
});

test("interactive Kanban handoff requires the assignee and explicit acceptance by the target profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-kanban-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.create("beta");
  const run = async (actor: string, lines: string[]): Promise<string> => {
    await profiles.select(actor);
    const output: string[] = [];
    await main([], {
      input: PassThrough.from([...lines.map((line) => `${line}\n`), "/exit\n"]),
      write: (text) => output.push(text), workingDirectory: workspace, configPath,
      profileStore: profiles, tools: [],
      model: { async respond() { throw new Error("Handoff reached model."); } },
    });
    return output.join("");
  };
  const created = await run("alpha", ["/kanban add alpha -- Transfer me"]);
  const id = created.match(/Kanban task created: ([0-9a-f-]{36})/)?.[1];
  assert.ok(id);
  assert.match(await run("beta", [`/kanban handoff offer ${id} 0 beta`]), /assignee/);
  assert.match(await run("alpha", [`/kanban handoff offer ${id} 0 beta`]), /handoff offered to beta/);
  assert.match(await run("alpha", [`/kanban progress ${id} 1 doing 1`]), /pending Kanban handoff/);
  assert.match(await run("beta", [`/kanban handoff accept ${id} 1`]), /revision 2/);
  assert.match(await run("alpha", [`/kanban handoff accept ${id} 1`]), /revision/);
  assert.equal((await createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, workspace), profiles).get("beta", id))?.assignee, "beta");
});

test("CLI worker recovery needs the assigned profile, inspected revision and typed confirmation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-kanban-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.create("beta");
  const boardPath = join(kanbanWorkspaceDirectory(configPath, workspace), "board.json");
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, workspace), profiles);
  const task = await board.create("alpha", "Recover owned task", "beta", []);
  const claimed = await board.claimWorker("beta", task.id, task.revision);
  const run = async (actor: string, lines: string[]): Promise<string> => {
    await profiles.select(actor);
    const output: string[] = [];
    await main([], {
      input: PassThrough.from([...lines.map((line) => `${line}\n`), "/exit\n"]),
      write: (text) => output.push(text), workingDirectory: workspace, configPath,
      profileStore: profiles, tools: [],
      model: { async respond() { throw new Error("Worker recovery reached model."); } },
    });
    return output.join("");
  };
  const command = (revision: number, pid: number) => `/kanban worker recover ${task.id} ${revision} ${pid}`;
  const status = await run("beta", [`/kanban status ${task.id}`]);
  assert.match(status, new RegExp(`Worker PID ${process.pid}`));
  assert.doesNotMatch(status, new RegExp(claimed.token));
  assert.match(await run("alpha", [command(claimed.task.revision, process.pid), "RECOVER"]), /assignee/);
  assert.match(await run("beta", [command(task.revision, process.pid), "RECOVER"]), /revision/);
  assert.match(await run("beta", [command(claimed.task.revision, process.pid), "NO"]), /not confirmed/);
  assert.match(await run("beta", [command(claimed.task.revision, process.pid), "RECOVER"]), /still active/);
  assert.equal((await board.get("beta", task.id))?.status, "doing");

  const persisted = JSON.parse(await readFile(boardPath, "utf8")) as { tasks: Array<{ workerClaim: { pid: number } }> };
  persisted.tasks[0]!.workerClaim.pid = 999999999;
  await writeFile(boardPath, JSON.stringify(persisted));
  assert.match(await run("beta", [command(claimed.task.revision, process.pid), "RECOVER"]), /changed/);
  const recovered = await run("beta", [command(claimed.task.revision, 999999999), "RECOVER"]);
  assert.match(recovered, /blocked/);
  assert.doesNotMatch(recovered, new RegExp(claimed.token));
  assert.equal((await board.get("beta", task.id))?.worker, undefined);
  assert.match(await run("beta", [command(claimed.task.revision, 999999999), "RECOVER"]), /revision/);
});
