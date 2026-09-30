import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileKanbanBoard, kanbanWorkspaceDirectory } from "../../dist/kanban.js";
import { runKanbanWorker } from "../../dist/kanban-worker.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "dragons-kanban-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.create("beta");
  const directory = kanbanWorkspaceDirectory(configPath, root);
  return { board: createFileKanbanBoard(directory, profiles), directory };
}

test("trusted worker runner claims in its process, fences concurrent work and persists no report", async (t) => {
  const { board, directory } = await fixture(t);
  const task = await board.create("alpha", "Check patch", "beta", []);
  let called = 0;
  const done = await runKanbanWorker({ board, actor: "beta", id: task.id, revision: task.revision,
    run: async (claimed, signal) => {
      called++;
      assert.equal(signal.aborted, false);
      assert.equal(claimed.id, task.id);
      assert.equal(claimed.worker?.pid, process.pid);
      assert.equal((await board.get("alpha", task.id))?.status, "doing");
      await assert.rejects(board.claimWorker("beta", task.id, task.revision), /revision/);
      await assert.rejects(board.updateProgress("beta", task.id, claimed.revision, "done", 100), /worker claim/);
      return "SENSITIVE REPORT NEVER SAVED";
    },
  });
  assert.equal(called, 1);
  assert.equal(done.status, "done");
  assert.equal(done.progress, 100);
  assert.equal(done.worker, undefined);
  assert.equal((await readFile(join(directory, "board.json"), "utf8")).includes("SENSITIVE REPORT"), false);
  await assert.rejects(runKanbanWorker({ board, actor: "beta", id: task.id, revision: task.revision,
    run: async () => { called++; },
  }), /revision/);
  assert.equal(called, 1);
});

test("worker failure and cooperative timeout release ownership as blocked without replay", async (t) => {
  const { board } = await fixture(t);
  const failed = await board.create("alpha", "First", "alpha", []);
  let called = 0;
  await assert.rejects(runKanbanWorker({ board, actor: "beta", id: failed.id, revision: failed.revision,
    run: async () => { called++; },
  }), /assignee/);
  assert.equal(called, 0);
  await assert.rejects(runKanbanWorker({ board, actor: "alpha", id: failed.id, revision: failed.revision,
    run: async () => { called++; throw new Error("Worker failed"); },
  }), /Worker failed/);
  assert.equal(called, 1);
  assert.equal((await board.get("alpha", failed.id))?.status, "blocked");
  assert.equal((await board.get("alpha", failed.id))?.worker, undefined);

  const timed = await board.create("alpha", "Second", "alpha", []);
  await assert.rejects(runKanbanWorker({ board, actor: "alpha", id: timed.id, revision: timed.revision, maxRunMs: 10,
    run: async (_task, signal) => { await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); },
  }), /timed out/);
  assert.equal((await board.get("alpha", timed.id))?.status, "blocked");
});

test("worker cancellation does not release a claim until noncooperative work actually settles", async (t) => {
  const { board } = await fixture(t);
  const task = await board.create("alpha", "Slow", "alpha", []);
  const stop = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let settle!: () => void;
  const ongoing = new Promise<void>((resolve) => { settle = resolve; });
  const running = runKanbanWorker({ board, actor: "alpha", id: task.id, revision: task.revision, signal: stop.signal,
    run: async () => { started(); await ongoing; },
  });
  await ready;
  stop.abort();
  assert.equal((await board.get("alpha", task.id))?.status, "doing");
  settle();
  await assert.rejects(running, /cancelled/);
  assert.equal((await board.get("alpha", task.id))?.status, "blocked");
  const before = await board.create("alpha", "Not started", "alpha", []);
  await assert.rejects(runKanbanWorker({ board, actor: "alpha", id: before.id, revision: before.revision, signal: stop.signal,
    run: async () => assert.fail("Cancelled worker must not start."),
  }), /cancelled/);
  assert.equal((await board.get("alpha", before.id))?.revision, 0);
});

test("worker lifecycle reports cleanup failure and leaves a claimed task for inspection", async (t) => {
  const { board } = await fixture(t);
  const task = await board.create("alpha", "Inspect cleanup", "alpha", []);
  const failing = { ...board, releaseWorker: async (): Promise<never> => { throw new Error("cleanup unavailable"); } };
  await assert.rejects(runKanbanWorker({ board: failing, actor: "alpha", id: task.id, revision: task.revision,
    run: async () => { throw new Error("model failed"); },
  }), (error: unknown) => error instanceof AggregateError && error.errors.length === 2
    && error.errors[0] instanceof Error && error.errors[0].message === "model failed"
    && error.errors[1] instanceof Error && error.errors[1].message === "cleanup unavailable");
  assert.equal((await board.get("alpha", task.id))?.status, "doing");
  assert.equal((await board.get("alpha", task.id))?.worker?.pid, process.pid);
  await assert.rejects(board.recoverWorker("alpha", task.id, 1, process.pid), /still active/);
});
