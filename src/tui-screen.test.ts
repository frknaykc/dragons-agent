import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";
import { InputDecoder } from "./tui/input.js";
import { clipLine, graphemes, renderScreen, terminalText, wrapText, type ViewState } from "./tui/screen.js";
import type { TuiState } from "./tui/controller.js";
import { parseCliCommand } from "./cli/commands.js";

const state: TuiState = { messages: [{ role: "assistant", text: "Merhaba 世界 👩‍💻 é" }], activity: [], background: [], busy: false };
const view: ViewState = { draft: "Furkan 世界", cursor: 9, scroll: 0, panel: "conversation", allowSelected: false };

test("M72 screen strips terminal commands and bidi controls from all display surfaces", () => {
  const unsafe = "safe\x1b[2J\x1b]52;c;synthetic\x07\x9b31m\r\u202euntrusted";
  const frame = renderScreen({ ...state, error: unsafe, activity: [unsafe], messages: [{ role: "user", text: unsafe }] }, { ...view, draft: unsafe }, 100, 24).join("\n");
  assert.doesNotMatch(frame, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/);
  assert.doesNotMatch(frame, /synthetic/);
  assert.match(frame, /safe/);
  assert.doesNotMatch(terminalText("a\x1b[31mb\x1b[0m"), /\x1b/);
});

test("M72 grapheme wrapping and clipping respect Unicode display cells", () => {
  assert.deepEqual(graphemes("é👩‍💻界"), ["é", "👩‍💻", "界"]);
  assert.equal(clipLine("A界B", 2), "A");
  assert.equal(clipLine("A界B", 3), "A界");
  for (const width of [1, 2, 3, 7]) {
    for (const line of wrapText("İstanbul 世界 👩‍💻 é", width)) assert.ok(stringWidth(line) <= width);
  }
});

test("M72 resize, scrolling and large output stay bounded without changing application state", () => {
  const data = { ...state, messages: [{ role: "assistant" as const, text: "line 世界\n".repeat(1600) }] };
  const before = JSON.stringify({ data, view });
  for (const [columns, rows] of [[80, 24], [25, 9], [1, 1], [300, 200], [50, 12]]) {
    const frame = renderScreen(data, view, columns!, rows!);
    assert.equal(frame.length, Math.min(rows!, 120));
    assert.ok(frame.every((line) => stringWidth(line) <= Math.min(239, columns! - 1)));
    assert.ok(frame.join("\n").length < 60_000);
  }
  assert.equal(JSON.stringify({ data, view }), before);
  assert.notDeepEqual(renderScreen({ ...state, messages: Array.from({ length: 50 }, (_, i) => ({ role: "notice", text: `line ${i}` })) }, view, 80, 24),
    renderScreen({ ...state, messages: Array.from({ length: 50 }, (_, i) => ({ role: "notice", text: `line ${i}` })) }, { ...view, scroll: 10 }, 80, 24));
});

test("M72 input decoder preserves split keys and makes bracketed paste inert", () => {
  const decoder = new InputDecoder();
  assert.deepEqual(decoder.feed("\x1b["), []);
  assert.deepEqual(decoder.feed("D"), [{ type: "left" }]);
  assert.deepEqual(decoder.feed("\x1b[200~\t\r\x03"), []);
  assert.deepEqual(decoder.feed("hello\x1b[20"), []);
  const pasted = decoder.feed("1~");
  assert.equal(pasted.length, 1);
  assert.equal(pasted[0]?.type, "insert");
  assert.ok(!JSON.stringify(pasted).includes('"enter"'));
  assert.deepEqual(decoder.feed("\x1b"), []);
  assert.deepEqual(decoder.flushEscape(), [{ type: "cancel" }]);
  assert.deepEqual(decoder.feed("\x04"), [{ type: "quit" }]);
  const huge = new InputDecoder();
  huge.feed("\x1b[200~" + "x".repeat(100_000));
  const result = huge.feed("\x1b[201~");
  assert.equal(result[0]?.type === "insert" && result[0].text.length, 8000);
});

test("M72 opt-in parser preserves legacy prompt commands and rejects ambiguous resume flags", () => {
  assert.deepEqual(parseCliCommand(["--tui", "--provider", "local", "--model", "fixture"]), { kind: "tui", provider: "local", model: "fixture" });
  assert.deepEqual(parseCliCommand(["--tui", "--resume", "session-1"]), { kind: "tui", resume: "session-1" });
  assert.equal(parseCliCommand(["tui"]).kind, "run");
  for (const args of [["--tui", "task"], ["--tui", "--model"], ["--tui", "--resume", "x", "--model", "y"], ["--tui", "--resume", "x", "--resume", "y"]]) assert.throws(() => parseCliCommand(args));
});
