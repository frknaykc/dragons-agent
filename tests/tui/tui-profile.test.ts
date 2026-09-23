import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../../dist/cli.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";

test("CLI custom config root reads and writes the selected profile, not the default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-profile-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  const base = JSON.stringify({ version: 1, provider: "local", model: "default-fixture" });
  await writeFile(configPath, base);
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("work");
  const work = await profiles.select("work");
  await writeFile(work.configPath, JSON.stringify({ version: 1, provider: "local", model: "work-fixture" }));
  let output = "";
  const dependencies = { configPath, write: (text: string) => { output += text; } };
  await main(["config", "show"], dependencies);
  assert.equal(JSON.parse(output).model, "work-fixture");
  await main(["config", "set-model", "local", "updated-fixture"], dependencies);
  assert.equal(JSON.parse(await readFile(work.configPath, "utf8")).models.local, "updated-fixture");
  assert.equal(await readFile(configPath, "utf8"), base);
  output = "";
  await main(["profile", "show"], dependencies);
  assert.match(output, /Active profile: work/);
});
