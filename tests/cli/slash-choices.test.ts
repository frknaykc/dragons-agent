import assert from "node:assert/strict";
import test from "node:test";
import { formatProviderList, LOGIN_PROVIDERS, loginSetup, slashChoices, SlashPicker } from "../../dist/slash-choices.js";
import { DEFAULT_PROVIDER_IDS } from "../../dist/provider/registry.js";
import { InputDecoder } from "../../dist/tui/input.js";

test("auth and logout complete provider arguments without trapping completed input", () => {
  const available = ["/auth", "/logout"];
  assert.equal(slashChoices("/auth status ", available).length, LOGIN_PROVIDERS.length);
  assert.deepEqual(slashChoices("/auth status gem", available).map((c) => c.value), ["/auth status gemini"]);
  assert.deepEqual(slashChoices("/logout gem", available).map((c) => c.value), ["/logout gemini"]);
  assert.deepEqual(slashChoices("/auth gem", available).map((c) => c.value), ["/auth gemini"]);
  assert.deepEqual(slashChoices("/auth status gemini ", available), []);
});

test("bounded shared choices filter commands/subcommands and do not invent reasoning or entitlement", () => {
  const allowed = ["/help", "/login", "/model", "/provider", "/profile"];
  assert.deepEqual(slashChoices("/lo", allowed).map((c) => c.value), ["/login"]);
  assert.deepEqual(slashChoices("/login open", allowed).map((c) => c.value), ["/login openai-api", "/login openrouter"]);
  assert.deepEqual(slashChoices("/profile se", allowed).map((c) => c.value), ["/profile select"]);
  for (const input of ["hello", "/reasoning ", "/" + "x".repeat(8000)]) assert.deepEqual(slashChoices(input, allowed), []);
  const provider = { id: "fixture", label: "Fixture", credentialRequirement: "none" as const, defaultModel: "known-default" };
  assert.deepEqual(slashChoices("/model ", allowed, [provider], "other"), []);
  const models = slashChoices("/model ", allowed, [provider], "fixture");
  assert.equal(models[0]!.value, "/model known-default");
  assert.match(models[0]!.description, /access not verified/);
  assert.deepEqual(new Set(LOGIN_PROVIDERS.map((p) => p.id)), new Set(DEFAULT_PROVIDER_IDS));
  assert.equal(loginSetup("chatgpt"), undefined);
  assert.match(loginSetup("gemini")!, /GEMINI_API_KEY/);
  assert.doesNotMatch(loginSetup("synthetic-secret")!, /synthetic-secret/);
});

test("provider display is bounded public metadata, not credential or entitlement state", () => {
  const text = formatProviderList([{
    id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "api-key",
    modelCatalogue: ["fixture-1", "fixture-2"], reasoningModels: { "fixture-1": ["low"] },
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: false, usageMetadata: false },
  }], "fixture");
  assert.match(text, /^Provider: fixture\nAvailable:/);
  assert.match(text, /credentials api-key; default fixture-1; 2 curated models; verified reasoning metadata; capabilities streaming, tool calls; access not verified/);
  assert.doesNotMatch(text, /secret|token|endpoint|factory|entitled/i);
  assert.equal(formatProviderList([], undefined), "Provider: none\nNo providers are registered.");
});

test("picker and raw decoder complete rather than execute, navigate and dismiss deterministically", () => {
  const choices = slashChoices("/login ", ["/login"]);
  const picker = new SlashPicker();
  const decoder = new InputDecoder();
  const keys = decoder.feed("\x1b[B\t\x1b[A\r");
  assert.deepEqual(keys.map((k) => k.type), ["down", "tab", "up", "enter"]);
  assert.equal(picker.key("down", choices), undefined);
  assert.equal(picker.key("tab", choices), "/login openai-api ");
  picker.key("up", choices);
  assert.equal(picker.key("enter", choices), "/login chatgpt ");
  picker.key("cancel", choices);
  assert.equal(picker.key("enter", choices), undefined);
  picker.reset();
  picker.key("up", choices);
  assert.equal(picker.key("enter", choices), "/login local ");
});
