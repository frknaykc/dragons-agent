import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeTextRedactor } from "./runtime-redaction.js";

const samples = [
  "Before Authorization: Basic fixtureCredential after.",
  'Before {"authorization":"Basic fixtureCredential"} after.',
  "Before Bearer fixtureCredential after.",
  "Before api_key = fixtureCredential after.",
  'Before {"password": "fixtureCredential with spaces"} after.',
  "Before https://fixture.invalid/?token=fixtureCredential&next=ok after.",
  "Before sk-fixtureCredential after.",
];

test("M71 streaming redaction is independent of chunk boundaries", () => {
  for (const text of samples) {
    for (let split = 0; split <= text.length; split += 1) {
      const redactor = new RuntimeTextRedactor();
      const output = redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.finish();
      assert.doesNotMatch(output, /fixtureCredential/);
      assert.match(output, /\[REDACTED\]/);
      assert.match(output, /Before /);
      assert.match(output, /after\./);
    }
    const redactor = new RuntimeTextRedactor();
    const output = [...text].map((char) => redactor.push(char)).join("") + redactor.finish();
    assert.doesNotMatch(output, /fixtureCredential/);
  }
});

test("M71 redaction preserves ordinary text and streams completed words", () => {
  const text = 'Normal response. Unicode: Türkçe 😀\nA quoted "word" remains. password policy';
  for (let split = 0; split <= text.length; split += 1) {
    const redactor = new RuntimeTextRedactor();
    assert.equal(redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.finish(), text);
  }
  const redactor = new RuntimeTextRedactor();
  assert.equal(redactor.push("Useful streamed words "), "Useful streamed words ");
});

test("M71 redaction bounds unfinished tokens and resets per response", () => {
  const redactor = new RuntimeTextRedactor();
  const output = redactor.push("x".repeat(32_000)) + redactor.finish();
  assert.ok(output.length < 100);
  assert.equal(redactor.push("next response ") + redactor.finish(), "next response ");
  const secret = new RuntimeTextRedactor();
  assert.doesNotMatch(secret.push('password="fixtureCredential') + secret.finish(), /fixtureCredential/);
});
