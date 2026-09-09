import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";
import { DRAGONS_ART } from "./terminal/banner.js";
import { createTerminalRenderer } from "./terminal/renderer.js";

for (const width of [24, 80, 120]) {
  test(`dragon-only startup frame fits ${width} terminal columns`, () => {
    let output = "";
    createTerminalRenderer({ write: (text) => { output += text; }, isTTY: true, color: false, width })
      .renderStartup({ provider: "OpenAI API", model: "test-model", workingDirectory: "/workspace" });
    const lines = output.split("\n");
    const start = lines.findIndex((line) => line.startsWith("╭"));
    const end = lines.findIndex((line) => line.startsWith("╰"));
    assert.ok(start >= 0 && end > start);
    const frame = lines.slice(start, end + 1);
    assert.equal(frame.length, DRAGONS_ART.split("\n").length + 2);
    for (const line of frame) assert.equal(stringWidth(line), width);
    for (const line of frame.slice(1, -1)) assert.match(line, /^│ [\u2800-\u28ff ]* │$/u);
    assert.doesNotMatch(output, /Hermes Agent|Nous Research|Available Tools|MCP Servers|Available Skills/);
    assert.doesNotMatch(output, /\x1b\[/);
    assert.ok(output.indexOf("OpenAI API") > output.indexOf("╰"));
  });
}

test("dragon uses a continuous gold-to-red gradient and composer uses a red separator", () => {
  let output = "";
  const renderer = createTerminalRenderer({ write: (text) => { output += text; }, isTTY: true, color: true, width: 100 });
  renderer.renderStartup({ provider: "OpenAI API", model: "test-model", workingDirectory: "." });
  const colors = [...output.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].slice(0, DRAGONS_ART.split("\n").length);
  assert.equal(colors.length, DRAGONS_ART.split("\n").length);
  assert.deepEqual(colors[0]!.slice(1), ["255", "185", "45"]);
  assert.deepEqual(colors.at(-1)!.slice(1), ["230", "57", "46"]);
  for (let index = 1; index < colors.length; index++) assert.ok(Number(colors[index]![2]) < Number(colors[index - 1]![2]));
  output = "";
  renderer.renderComposer();
  assert.ok(output.includes(`\x1b[31m${"─".repeat(100)}\x1b[0m`));
  assert.equal(output.split("─".repeat(100)).length - 1, 2);
  assert.ok(output.includes("\x1b[1A\r"));
  output = "";
  renderer.finishComposer();
  assert.equal(output, `\r\x1b[2K\x1b[31m${"─".repeat(100)}\x1b[0m\n`);
});

test("startup title, motto and metadata are centered across the terminal", () => {
  let output = "";
  createTerminalRenderer({ write: (text) => { output += text; }, isTTY: true, color: false, width: 120 })
    .renderStartup({ provider: "OpenAI API", model: "test-model", workingDirectory: "/workspace" });
  for (const line of output.split("\n").filter((line) => line.trim() && !/[╭╰│\u2800-\u28ff]/u.test(line))) {
    const left = line.length - line.trimStart().length;
    const right = 120 - stringWidth(line);
    assert.ok(Math.abs(left - right) <= 1, line);
  }
});
