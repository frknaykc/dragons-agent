import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { main } from "../../dist/cli.js";
import { createLineInput } from "../../dist/cli/line-input.js";
import { slashChoices } from "../../dist/slash-choices.js";
import { createApiKeyAuth } from "../../dist/provider/api-key-auth.js";
import { setTimeout as delay } from "node:timers/promises";

class Keyboard extends PassThrough {
  isTTY = true;
  isRaw = false;
  modes: boolean[] = [];
  setRawMode(value: boolean) { this.isRaw = value; this.modes.push(value); return this; }
}

async function until(predicate: () => boolean) {
  // Startup includes filesystem work: event-loop turn counts are not an I/O deadline.
  const deadline = performance.now() + 2000;
  while (!predicate() && performance.now() < deadline) await delay(5);
  assert.ok(predicate(), "expected keyboard/UI transition");
}

test("real CLI stdin slash selection is local; only a separate Enter submits login", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-picker-"));
  const input = new Keyboard();
  let output = "";
  let logins = 0;
  const resizeSource = Object.assign(new EventEmitter(), { columns: 148 });
  const running = main([], {
    input, workingDirectory: root, configPath: join(root, "config.json"), sessionDirectory: join(root, "sessions"), config: {}, tools: [],
    terminal: { inputIsTTY: true, outputIsTTY: true, color: false, resizeSource },
    write: (text) => { output += text; },
    model: { async respond() { assert.fail("picker must not invoke model"); } },
    chatgptAuth: { async login() { logins++; }, async logout() {}, async status() { return { authenticated: false }; } },
  });
  try {
    await until(() => output.includes("Ask anything"));
    input.write("/");
    await until(() => output.includes("/new"));
    input.write("login ");
    await until(() => output.includes("/login chatgpt"));
    const beforeResize = output.length;
    resizeSource.columns = 55;
    resizeSource.emit("resize");
    assert.match(output.slice(beforeResize), /\/login chatgpt/);
    input.write("\u001b[B\u001b[A\t");
    await tick();
    assert.equal(logins, 0);
    const composers = output.split("Ask anything").length;
    input.write("\r");
    await until(() => logins === 1 && output.split("Ask anything").length > composers);
    input.write("/exit \r");
    await running;
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(input.isPaused(), true, "closed CLI must not leave stdin flowing and keep the process alive");
    assert.equal(resizeSource.listenerCount("resize"), 0);
  } finally {
    input.end();
    await running;
    await rm(root, { recursive: true, force: true });
  }
});

function fixture(terminal = true, columns = 80) {
  const input = new Keyboard();
  const resizeSource = Object.assign(new EventEmitter(), { columns });
  let output = "";
  let interrupts = 0;
  const lines = createLineInput({ input, terminal, columns, resizeSource, write: (text) => { output += text; },
    interrupt: () => { interrupts++; }, choices: (text) => slashChoices(text, ["/new", "/login", "/exit"]) });
  return { input, lines, resizeSource, output: () => output, interrupts: () => interrupts };
}

test("output resize immediately refits a visible picker and releases its listener", async () => {
  const f = fixture(true, 148);
  try {
    f.lines.composer();
    f.input.write("/login ");
    const before = f.output().length;
    f.resizeSource.columns = 55;
    f.resizeSource.emit("resize");
    const resized = f.output().slice(before);
    assert.match(resized, /\/login chatgpt/);
    const rows = [...resized.matchAll(/\n\r\x1b\[2K([^\x1b\n]*)/g)].map((match) => match[1]!);
    assert.ok(rows.length > 1);
    assert.ok(rows.every((row) => row.length < 55));
    assert.ok(resized.endsWith("\x1b[12G"), "cursor returns to the input, not an option");
    f.input.write("\x1b[B\t\r");
    assert.equal((await f.lines.next()).value, "/login openai-api ");
  } finally { f.lines.close(); }
  assert.equal(f.resizeSource.listenerCount("resize"), 0);
  const after = f.output();
  f.resizeSource.emit("resize");
  assert.equal(f.output(), after);
});

test("resize rebases wrapped readline cursor before clearing reflowed overlay rows", async () => {
  const input = new Keyboard();
  const resizeSource = Object.assign(new EventEmitter(), { columns: 148 });
  let output = "";
  const text = "/" + "x".repeat(175);
  const lines = createLineInput({ input, terminal: true, resizeSource, write: (chunk) => { output += chunk; },
    choices: () => [{ value: "/fixture", description: "long overlay ".repeat(15) }], interrupt() {} });
  try {
    lines.composer();
    input.write(text);
    output = "";
    resizeSource.columns = 55;
    resizeSource.emit("resize");
    // Old cursor row 1, reflowed cursor row 3: compensate before readline's own refresh.
    assert.ok(output.startsWith("\x1b[2A\x1b[1A\x1b[1G\x1b[0J"), JSON.stringify(output));
    assert.ok(output.endsWith("\x1b[16G"));
    input.write("\x1b[D"); // Edit in the middle; overlay must stay hidden through another resize.
    output = "";
    resizeSource.columns = 100;
    resizeSource.emit("resize");
    assert.ok(output.startsWith("\n\n\x1b[3A\x1b[1G\x1b[0J"), JSON.stringify(output));
    assert.doesNotMatch(output, /long overlay/);
    input.write("!\r");
    assert.equal((await lines.next()).value, text.slice(0, -1) + "!x");
  } finally { lines.close(); }
  assert.equal(resizeSource.listenerCount("resize"), 0);
});

test("resize preserves dismissed picker, approval, busy output and cancellation cleanup", async () => {
  const f = fixture(true, 148);
  f.lines.composer();
  f.input.write("/login \x1b");
  await new Promise((resolve) => setTimeout(resolve, 550)); // readline's lone-Escape timeout
  let before = f.output().length;
  f.resizeSource.columns = 55;
  f.resizeSource.emit("resize");
  assert.doesNotMatch(f.output().slice(before), /Up\/Down|\/login chatgpt/);
  f.input.write("\x15");
  f.lines.approval();
  f.input.write("y");
  before = f.output().length;
  f.resizeSource.columns = 100;
  f.resizeSource.emit("resize");
  assert.equal(f.output().length, before, "external approval question is not erased");
  f.input.write("es\r");
  assert.equal((await f.lines.next()).value, "yes");
  before = f.output().length;
  f.resizeSource.columns = 55;
  f.resizeSource.emit("resize");
  assert.equal(f.output().length, before, "busy output is not overwritten");
  f.lines.composer();
  f.input.write("/login \x03");
  assert.equal(f.interrupts(), 1);
  f.lines.close();
  assert.equal(f.resizeSource.listenerCount("resize"), 0);
  assert.equal(f.input.isPaused(), true);
});

test("pipe input never subscribes to output resize", async () => {
  const f = fixture(false);
  f.resizeSource.columns = 55;
  f.resizeSource.emit("resize");
  f.input.end("/login chatgpt\n");
  assert.equal((await f.lines.next()).value, "/login chatgpt");
  f.lines.close();
  assert.equal(f.output(), "");
  assert.equal(f.resizeSource.listenerCount("resize"), 0);
});

for (const select of ["\t", "\r"]) {
  test(`keyboard ${JSON.stringify(select)} inserts selection, never resolves answer until next Enter`, async () => {
    const f = fixture();
    try {
      f.lines.composer();
      let answer: IteratorResult<string> | undefined;
      const waiting = f.lines.next().then((value) => { answer = value; });
      f.input.write("/login ");
      // Include a fragmented terminal escape sequence, wrapping up/down, then select.
      f.input.write("\u001b["); f.input.write("A");
      f.input.write("\u001b[B\u001b[B");
      f.input.write(select);
      await tick();
      assert.equal(answer, undefined);
      assert.match(f.output(), /\/login openai-api/);
      f.input.write("\r");
      await waiting;
      assert.deepEqual(answer, { done: false, value: "/login openai-api " });
    } finally { f.lines.close(); }
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount("data"), 0);
  });
}

test("selecting /login shows provider choices without authenticating or trapping the next Enter", async () => {
  const f = fixture();
  try {
    f.lines.composer();
    let submitted = false;
    const pending = f.lines.next().then((answer) => { submitted = true; return answer; });
    f.input.write("/lo\t");
    await tick();
    assert.equal(submitted, false);
    assert.match(f.output(), /\/login chatgpt/);
    f.input.write("\r");
    assert.equal((await pending).value, "/login ");
  } finally { f.lines.close(); }
});

test("Escape dismisses without losing text; normal editing and approval bypass completion", async () => {
  const f = fixture();
  try {
    f.lines.composer();
    const answer = f.lines.next();
    f.input.write("/lo");
    f.input.write("\u001b");
    await delay(550); // Node's public key decoder disambiguates a lone Escape from arrows.
    f.input.write("\r");
    assert.equal((await answer).value, "/lo");
    f.lines.approval();
    const approval = f.lines.next();
    const before = f.output().length;
    f.input.write("/login\r");
    assert.equal((await approval).value, "/login");
    assert.doesNotMatch(f.output().slice(before), /Device sign-in|Enter again/);
    f.lines.composer();
    const edited = f.lines.next();
    f.input.write("héx\u007flo\u001b[D!\r");
    assert.equal((await edited).value, "hél!o");
    f.input.write("\u0003");
    assert.equal(f.interrupts(), 1, "busy/auth mode must still deliver raw Ctrl+C");
  } finally { f.lines.close(); }
});

test("redirected line input stays plain and queues pipe lines without ANSI or raw mode", async () => {
  const f = fixture(false);
  f.lines.composer();
  f.input.end("/login local\n/exit\n");
  assert.equal((await f.lines.next()).value, "/login local");
  assert.equal((await f.lines.next()).value, "/exit");
  assert.equal((await f.lines.next()).done, true);
  f.lines.close();
  assert.equal(f.output(), "");
  assert.deepEqual(f.input.modes, []);
});

for (const end of ["eof", "ctrl-d", "close"] as const) {
  test(`keyboard ${end} releases raw mode, listeners and pending answer`, async () => {
    const f = fixture();
    f.lines.composer();
    const pending = f.lines.next();
    if (end === "eof") f.input.end();
    else if (end === "ctrl-d") f.input.write("\u0004");
    else f.lines.close();
    assert.equal((await pending).done, true);
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount("data"), 0);
    f.lines.close();
  });
}

for (const response of ["y\r", "n\r", "\u0003"]) {
  test(`TTY approval ${JSON.stringify(response)} uses the existing authority and restores composer`, { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons-picker-approval-"));
    const input = new Keyboard();
    let executions = 0;
    let turns = 0;
    let composers = 0;
    try {
      await main([], {
        input, workingDirectory: root, configPath: join(root, "config.json"), sessionDirectory: join(root, "sessions"), config: {},
        terminal: { inputIsTTY: true, outputIsTTY: true, columns: 100, color: false },
        model: { async respond() {
          return { responseId: `fixture-${++turns}`, text: turns === 1 ? "" : "done",
            toolCalls: turns === 1 ? [{ callId: "fixture", name: "fixture_write", arguments: "{}" }] : [] };
        } },
        tools: [{ name: "fixture_write", operation: "WRITE", description: "fixture only", inputSchema: { type: "object", properties: {}, additionalProperties: false },
          async execute() { executions++; return { ok: true, output: "fixture only" }; } }],
        write(text) {
          if (text.includes("Ask anything")) {
            composers++; setImmediate(() => input.write(composers === 1 ? "fixture request\r" : "/exit \r"));
          }
          if (text.includes("Allow once?")) setImmediate(() => input.write(response));
        },
      });
      assert.equal(executions, response === "y\r" ? 1 : 0);
      assert.equal(composers, 2);
      assert.equal(input.isRaw, false);
      assert.equal(input.listenerCount("data"), 0);
    } finally { input.destroy(); await rm(root, { recursive: true, force: true }); }
  });
}

test("raw Ctrl+C interrupts OAuth and leaves the local composer usable", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-picker-oauth-"));
  const input = new Keyboard();
  let cancelled = false;
  let composers = 0;
  try {
    await main([], {
      input, workingDirectory: root, configPath: join(root, "config.json"), sessionDirectory: join(root, "sessions"), config: {}, tools: [],
      terminal: { inputIsTTY: true, outputIsTTY: true, color: false },
      model: { async respond() { assert.fail("no model call"); } },
      chatgptAuth: {
        async login(options) {
          const signal = options?.signal;
          assert.ok(signal);
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true });
            setImmediate(() => input.write("\u0003"));
          });
          throw new Error("fixture cancelled");
        },
        async logout() {}, async status() { return { authenticated: false }; },
      },
      write(text) {
        if (text.includes("Ask anything")) {
          composers++; setImmediate(() => input.write(composers === 1 ? "/login chatgpt \r" : "/exit \r"));
        }
      },
    });
    assert.equal(cancelled, true);
    assert.equal(composers, 2);
    assert.equal(input.isRaw, false);
  } finally { input.destroy(); await rm(root, { recursive: true, force: true }); }
});

for (const cancel of [false, true]) {
  test(`TTY picker masked login ${cancel ? "cancel" : "save"} detaches and restores keyboard`, { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons-picker-secret-"));
    const input = new Keyboard();
    let output = "";
    let stored: string | undefined;
    let requested = false;
    const secret = "fixture-only-picker-key";
    const apiKeyAuth = createApiKeyAuth("default", () => ({
      async load() { return stored; }, async save(value) { stored = value; }, async remove() {},
    }));
    try {
      await main([], {
        input, apiKeyAuth, workingDirectory: root, configPath: join(root, "config.json"),
        sessionDirectory: join(root, "sessions"), config: {}, tools: [],
        terminal: { inputIsTTY: true, outputIsTTY: true, color: false, columns: 100 },
        model: { async respond() { assert.fail("no model request"); } },
        secretOutput: { isTTY: true, write(chunk: unknown) {
          assert.ok(!String(chunk).includes(secret));
          if (String(chunk) === "API key (Enter saves; Esc cancels): ") {
            assert.equal(input.listenerCount("data"), 1, "only secret reader observes stdin");
            setImmediate(() => input.write(secret + (cancel ? "\u0003" : "\r") + "discard-tail\n"));
          }
          return true;
        } },
        write(text) {
          output += text;
          if (!requested && text.includes("Ask anything")) {
            requested = true; setImmediate(() => input.write("/login gemini \r"));
          }
          if (/API key saved|sign-in cancelled/.test(text)) setImmediate(() => input.write("/exit \r"));
        },
      });
      assert.equal(stored, cancel ? undefined : secret);
      assert.doesNotMatch(output, /fixture-only-picker-key|discard-tail/);
      assert.equal(input.isRaw, false);
      assert.equal(input.listenerCount("data"), 0);
      assert.deepEqual(input.modes, [true, false, true, false, true, false]);
    } finally { input.destroy(); await rm(root, { recursive: true, force: true }); }
  });
}
