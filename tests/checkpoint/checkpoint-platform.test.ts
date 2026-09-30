import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionCheckpoints } from "../../dist/checkpoint.js";
import { createCodingTools } from "../../dist/tools.js";
import { safeCheckpointIoAvailable } from "../../dist/checkpoint-win32.js";

// Checkpoint capture is unavailable on platforms without no-follow opens.
// An approved legacy write can still proceed, but must report absent coverage.
test("unsupported checkpoint platform refuses capture without changing the file or claiming recovery", { skip: safeCheckpointIoAvailable }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-checkpoint-platform-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  await writeFile(path, "before");
  const history = new SessionCheckpoints(root);
  const mutation = [{ path: "file.txt", content: "after" }];
  assert.deepEqual(history.classify(mutation), { kind: "unsupported", reason: "platform" });
  const refused = history.mutate(mutation);
  assert.equal(refused.ok, false);
  assert.match(refused.output, /platform unsupported/);
  assert.equal(await readFile(path, "utf8"), "before");
  assert.match(history.list(), /No checkpoints/);

  const write = (await createCodingTools(root)).find((tool) => tool.name === "write_file")!;
  const result = await write.execute({ path: "file.txt", content: "after" }, { checkpoints: history });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rollbackCoverage, { kind: "unsupported", reason: "platform" });
  assert.equal(await readFile(path, "utf8"), "after");
  assert.match(history.list(), /No checkpoints/);
});
