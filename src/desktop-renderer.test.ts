import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function renderer() {
  const nodes = new Map<string, any>();
  const element = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", value: "", disabled: false, hidden: true, children: [],
      append(node: any) { this.children.push(node); }, replaceChildren() { this.children = []; },
      get childElementCount() { return this.children.length; } });
    return nodes.get(id);
  };
  let status: () => Promise<unknown> = async () => ({ session: { id: "session" } });
  const context = vm.createContext({ document: { getElementById: element, createElement: () => ({ textContent: "" }) },
    window: { addEventListener() {}, dragons: { events: () => new Promise(() => {}),
      request: async (message: { type: string }) => ({ ok: true, value: message.type === "status" ? await status() : [] }) } },
    setTimeout, Error, Promise });
  vm.runInContext(await readFile(new URL("../desktop/renderer.js", import.meta.url), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("session={id:'session',provider:'fixture',model:'fixture'};mayControl=false;controls();", context);
  return { context, nodes, setStatus: (next: typeof status) => { status = next; }, run: (code: string): any => vm.runInContext(code, context) };
}

test("M75 renderer does not resurrect a completed run from a late status reply", async () => {
  const f = await renderer(); let resolve!: (value: unknown) => void;
  f.setStatus(() => new Promise((yes) => { resolve = yes; }));
  f.run("receive({type:'run_started',runId:'run',sessionId:'session'});");
  const refreshed = f.run("refresh()");
  f.run("receive({type:'run_completed',runId:'run',sessionId:'session',result:{finalText:'done'}});");
  resolve({ activeRunId: "run", session: { id: "session" }, shared: { clientId: "observer", ownerClientId: "owner", revision: 1 } });
  await refreshed;
  assert.equal(f.run("busy"), false); assert.equal(f.run("runId"), undefined);
  assert.equal(f.nodes.get("send").disabled, false);
});

test("M75 renderer reconciles an idle status and ignores a stale refresh after session switch", async () => {
  const f = await renderer();
  f.run("runId='stale';busy=true;");
  await f.run("refresh()"); assert.equal(f.run("busy"), false); assert.equal(f.run("runId"), undefined);
  let resolve!: (value: unknown) => void;
  f.setStatus(() => new Promise((yes) => { resolve = yes; }));
  const refreshed = f.run("refresh()");
  f.run("session={id:'new-session',provider:'fixture',model:'other'};");
  resolve({ activeRunId: "old-session-run", session: { id: "session" } }); await refreshed;
  assert.equal(f.run("runId"), undefined);
});

test("M75 renderer accepts matching ownership metadata when run-start arrives before status", async () => {
  const f = await renderer(); let resolve!: (value: unknown) => void;
  f.run("mayControl=true;"); f.setStatus(() => new Promise((yes) => { resolve = yes; }));
  const refreshed = f.run("refresh()");
  f.run("receive({type:'run_started',runId:'run',sessionId:'session'});");
  resolve({ activeRunId: "run", session: { id: "session" }, shared: { clientId: "observer", ownerClientId: "owner", revision: 1 } });
  await refreshed; assert.equal(f.run("busy"), true); assert.equal(f.nodes.get("cancel").disabled, true);
});
