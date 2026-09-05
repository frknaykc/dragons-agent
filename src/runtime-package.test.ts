import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("M71 exposes the stable runtime facade from the installed package root", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    exports?: Record<string, string>;
    types?: string;
  };
  assert.equal(manifest.exports?.["."], "./dist/runtime.js");
  assert.equal(manifest.exports?.["./runtime"], "./dist/runtime.js");
  assert.equal(manifest.types, "./dist/runtime.d.ts");

  const runtimeModule = await import(manifest.name);
  assert.equal(typeof runtimeModule.createDragonsRuntime, "function");
});
