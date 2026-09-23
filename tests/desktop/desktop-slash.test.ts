import assert from "node:assert/strict";
import { createApiKeyAuth } from "../../dist/provider/api-key-auth.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopBridge, type DesktopLocalControls, type DesktopBridgeReply } from "../../dist/desktop/bridge.js";
import { createDesktopLocalControls } from "../../dist/desktop/local-controls.js";
import { desktopLocalControls } from "../../dist/desktop/host.js";
import { createChatGPTAuthService, type CodexCredentials } from "../../dist/provider/codex-auth.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";
import { createSessionStore } from "../../dist/session-store.js";
import type { DragonsRuntime } from "../../dist/runtime.js";

test("desktop close during token JSON parsing cannot save a late login", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-login-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let entered!: () => void; let release!: () => void;
  const parsing = new Promise<void>((resolve) => { entered = resolve; });
  const body = new Promise<void>((resolve) => { release = resolve; });
  let saves = 0;
  const { controls: local } = createDesktopLocalControls({
    profiles: createDragonsProfileStore({ configPath: join(directory, "config.json") }),
    profileName: "default", sessions: createSessionStore(join(directory, "sessions")), workingDirectory: directory,
    createAuth: (options) => createChatGPTAuthService({ ...options, sleep: async () => {} }),
    authOptions: {
      credentialStore: { load: async () => undefined, save: async () => { saves++; }, remove: async () => {}, storageDescription: async () => "fixture" },
      fetchImpl: async (input) => {
        if (String(input).endsWith("/usercode")) return Response.json({ user_code: "ABCD-EFGH", device_auth_id: "fixture" });
        if (String(input).endsWith("/deviceauth/token")) return Response.json({ authorization_code: "fixture", code_verifier: "fixture" });
        const response = Response.json({});
        response.json = async () => { entered(); await body; return { access_token: "synthetic-access", refresh_token: "synthetic-refresh" }; };
        return response;
      },
    },
  });
  await local.login();
  await parsing;
  const closing = local.close();
  release();
  await closing;
  assert.equal(saves, 0);
});

test("desktop API-key login is host-only, secret-free in replies/runtime and closes after verified persistence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-api-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let saved: string | undefined;
  const auth = createApiKeyAuth("work", (provider) => {
    assert.equal(provider, "gemini");
    return { load: async () => saved, save: async (key) => { saved = key; }, remove: async () => { saved = undefined; } };
  });
  const { controls: local } = createDesktopLocalControls({
    apiKeyAuth: auth, profiles: createDragonsProfileStore({ configPath: join(directory, "config.json") }),
    profileName: "work", sessions: createSessionStore(join(directory, "sessions")), workingDirectory: directory, authOptions: {},
  });
  local.requestSecret = async () => "synthetic-private-key";
  const f = fixture(local);
  const reply = await f.bridge.request({ type: "slash", content: "/login gemini" });
  assert.equal(value(reply).kind, "restart");
  assert.doesNotMatch(JSON.stringify(reply), /synthetic-private-key/);
  assert.equal(saved, "synthetic-private-key");
  assert.deepEqual(f.calls, ["dispose"]);
  assert.equal((await f.bridge.request({ type: "create" })).ok, false);
});

test("desktop pending API-key login rejects concurrent commands and close prevents late persistence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-api-key-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release!: (key: string | undefined) => void;
  let writes = 0;
  const { controls: local } = createDesktopLocalControls({
    apiKeyAuth: createApiKeyAuth("default", () => ({ load: async () => undefined, save: async () => { writes++; }, remove: async () => {} })),
    profiles: createDragonsProfileStore({ configPath: join(directory, "config.json") }),
    profileName: "default", sessions: createSessionStore(join(directory, "sessions")), workingDirectory: directory, authOptions: {},
  });
  local.requestSecret = async () => new Promise((resolve) => { release = resolve; });
  const f = fixture(local);
  const pending = f.bridge.request({ type: "slash", content: "/login gemini" });
  assert.equal((await f.bridge.request({ type: "create" })).ok, false);
  assert.equal((await f.bridge.request({ type: "slash", content: "/login gemini" })).ok, false);
  const closed = f.bridge.close();
  release("synthetic-late-secret");
  await closed;
  assert.equal((await pending).ok, false);
  assert.equal(writes, 0);
});

test("desktop cancelled or failed key prompts never close runtime or echo secrets", async () => {
  const local = controls([]); local.requestSecret = async () => undefined;
  local.loginApiKey = async () => false;
  const f = fixture(local);
  assert.match(value(await f.bridge.request({ type: "slash", content: "/login gemini" })).text, /cancelled/);
  local.loginApiKey = async () => { throw new Error("synthetic-private-key"); };
  const reply = await f.bridge.request({ type: "slash", content: "/login gemini" });
  assert.equal(reply.ok, false);
  assert.doesNotMatch(JSON.stringify(reply), /synthetic-private-key/);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.bridge.request({ type: "api-key", provider: "gemini", key: "synthetic-private-key" })).ok, false);
  await f.bridge.close();
});


test("desktop named API-key slot list and removal are local, bounded, and quiesced", async () => {
  const local = controls([]);
  local.listApiKeySlots = async (provider) => { assert.equal(provider, "gemini"); return "primary: cooldown"; };
  const f = fixture(local);
  const listed = value(await f.bridge.request({ type: "slash", content: "/login list gemini" }));
  assert.equal(listed.text, "primary: cooldown");
  local.removeApiKeySlot = async (provider, slot) => {
    assert.equal(provider, "gemini"); assert.equal(slot, "primary"); assert.deepEqual(f.calls, ["dispose"]);
  };
  const removed = value(await f.bridge.request({ type: "slash", content: "/logout gemini primary" }));
  assert.equal(removed.kind, "restart");
  assert.match(removed.text, /Named API-key slot removed/);
});

test("desktop API-key status and logout use only the selected profile/provider and quiesce before removal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-api-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entries = new Map([["work:gemini", "synthetic-private-key"], ["other:gemini", "other-key"], ["work:anthropic", "another-key"]]);
  const calls: string[] = [];
  const { controls: local } = createDesktopLocalControls({
    apiKeyAuth: createApiKeyAuth("work", (provider) => ({
      load: async () => { calls.push(`load:${provider}`); return entries.get(`work:${provider}`); },
      save: async () => assert.fail("no writes"),
      remove: async () => {
        assert.deepEqual(f.calls, ["dispose"]);
        assert.equal((await f.bridge.request({ type: "create" })).ok, false);
        calls.push(`remove:${provider}`); entries.delete(`work:${provider}`);
      },
    })),
    profiles: createDragonsProfileStore({ configPath: join(directory, "config.json") }),
    profileName: "work", sessions: createSessionStore(join(directory, "sessions")), workingDirectory: directory, authOptions: {},
  });
  local.defaultProvider = "gemini";
  const f = fixture(local);
  for (const content of ["/auth", "/auth status", "/auth gemini", "/auth status gemini"]) {
    const reply = value(await f.bridge.request({ type: "slash", content }));
    assert.match(reply.text, /gemini: API key stored/);
    assert.doesNotMatch(JSON.stringify(reply), /synthetic-private-key|other-key|another-key/);
    assert.ok(reply.text.length < 300);
  }
  assert.match(value(await f.bridge.request({ type: "slash", content: "/auth openrouter" })).text, /No API key stored/);
  const status = local.auth;
  local.auth = async () => { throw new Error("synthetic-private-key"); };
  const failed = await f.bridge.request({ type: "slash", content: "/auth gemini" });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-key/);
  assert.deepEqual(f.calls, []);
  local.auth = status;
  const reply = value(await f.bridge.request({ type: "slash", content: "/logout" }));
  assert.equal(reply.kind, "restart");
  assert.match(reply.text, /Environment credentials remain unchanged/);
  assert.equal(entries.has("work:gemini"), false);
  assert.equal(entries.size, 2);
  assert.deepEqual(calls, ["load:gemini", "load:gemini", "load:gemini", "load:gemini", "load:openrouter", "remove:gemini"]);
});

test("desktop auth provider precedence, unknown arguments and remote rejection are fail closed", async () => {
  const local = controls([]); const calls: string[] = [];
  local.defaultProvider = "openai-api";
  local.auth = async (provider) => { calls.push(provider!); return "bounded status"; };
  const f = fixture(local);
  await f.bridge.request({ type: "slash", content: "/auth" });
  f.runtime.status = async () => ({ session: { id, provider: "anthropic", model: "fixture" } }) as Awaited<ReturnType<DragonsRuntime["status"]>>;
  await f.bridge.request({ type: "create" });
  await f.bridge.request({ type: "slash", content: "/auth status" });
  await f.bridge.request({ type: "slash", content: "/auth status gemini" });
  assert.deepEqual(calls, ["openai-api", "anthropic", "gemini"]);
  for (const content of ["/auth unknown", "/logout unknown", "/auth status gemini extra", "/logout gemini extra", "/auth local"]) {
    assert.equal(value(await f.bridge.request({ type: "slash", content })).kind, "text");
  }
  assert.deepEqual(calls, ["openai-api", "anthropic", "gemini"]);
  assert.deepEqual(f.calls, ["create"]);
  const remote = fixture();
  for (const content of ["/auth gemini", "/auth status gemini", "/logout gemini"]) {
    assert.match(value(await remote.bridge.request({ type: "slash", content })).text, /unavailable on remote/);
  }
  assert.deepEqual(remote.calls, []);
  await remote.bridge.close(); await f.bridge.close();
});

test("desktop key logout errors redact private details and leave cached runtime closed", async () => {
  const local = controls([]); const f = fixture(local);
  local.logout = async (provider) => {
    assert.equal(provider, "openrouter");
    assert.deepEqual(f.calls, ["dispose"]);
    throw new Error("synthetic-private-key");
  };
  const reply = await f.bridge.request({ type: "slash", content: "/logout openrouter" });
  assert.equal(reply.ok, false);
  assert.doesNotMatch(JSON.stringify(reply), /synthetic-private-key/);
  assert.equal((await f.bridge.request({ type: "create" })).ok, false);
});

test("desktop close during API-key status discards late results and rejects concurrent logout", async () => {
  const local = controls([]); const f = fixture(local);
  let release!: (text: string) => void;
  local.auth = async () => new Promise((resolve) => { release = resolve; });
  const pending = f.bridge.request({ type: "slash", content: "/auth gemini" });
  assert.equal((await f.bridge.request({ type: "slash", content: "/logout gemini" })).ok, false);
  await f.bridge.close();
  release("late public status");
  assert.equal((await pending).ok, false);
});

const id = "12345678-1234-1234-1234-123456789012";
function value(reply: DesktopBridgeReply): any { assert.equal(reply.ok, true); if (!reply.ok) throw new Error("failed"); return reply.value; }
function fixture(local?: DesktopLocalControls) {
  const calls: string[] = [];
  const runtime = {
    providers: () => [],
    createSession: async () => { calls.push("create"); return { id, provider: "local", model: "fixture" }; },
    resumeSession: async (sessionId: string) => { calls.push(sessionId); return { id: sessionId, provider: "local", model: "fixture" }; },
    status: async () => ({ session: { id } }),
    dispose: async () => { calls.push("dispose"); },
    sendUserInput: async () => { calls.push("MODEL"); throw new Error("must not call"); },
  } as unknown as DragonsRuntime;
  return { bridge: new DesktopBridge(runtime, () => {}, local), runtime, calls };
}
function controls(calls: string[]): DesktopLocalControls {
  return {
    sessions: async () => "saved session", auth: async () => "signed out", login: async () => "login challenge", logout: async () => "signed out",
    profiles: async () => "default", createProfile: async (name) => { calls.push(name); return name; },
    selectProfile: async (name) => { calls.push(`select:${name}`); }, close: async () => { calls.push("close-auth"); },
  };
}
test("desktop slash dispatch handles filtered help, new/reset, resume and status; unknown send never reaches model", async () => {
  const f = fixture();
  assert.match(value(await f.bridge.request({ type: "slash", content: "/help resume" })).text, /\/resume/);
  assert.doesNotMatch(value(await f.bridge.request({ type: "slash", content: "/help" })).text, /\/login|\/sessions/);
  for (const content of ["/new", "/reset", `/resume ${id}`]) assert.equal(value(await f.bridge.request({ type: "slash", content })).kind, "session");
  assert.match(value(await f.bridge.request({ type: "slash", content: "/session" })).text, new RegExp(id));
  for (const content of ["  /unknown", "/resume bad", "/new extra", "/logout", "/profile select remote"]) {
    assert.equal(value(await f.bridge.request({ type: "send", content })).kind, "text");
  }
  assert.deepEqual(f.calls, ["create", "create", id]);
  assert.equal(desktopLocalControls(f.runtime), undefined);
  await f.bridge.close();
});
test("desktop provider chooser never triggers OAuth implicitly or sends credentials to runtime", async () => {
  let logins = 0;
  const local = controls([]); local.login = async () => { logins++; return "challenge"; };
  const f = fixture(local);
  const choices = value(await f.bridge.request({ type: "choices", content: "/login " }));
  assert.ok(choices.some((c: { value: string }) => c.value === "/login chatgpt"));
  for (const content of ["/login", "/login openai-api", "/login chatgpt synthetic-secret"]) {
    const reply = value(await f.bridge.request({ type: "slash", content }));
    assert.doesNotMatch(reply.text, /synthetic-secret/);
  }
  assert.equal(logins, 0); assert.deepEqual(f.calls, []);
  await f.bridge.request({ type: "slash", content: "/login chatgpt" });
  assert.equal(logins, 1);
  await f.bridge.close();
});

test("desktop local commands validate exact input and keep selection shut down before persistent mutation", async () => {
  const calls: string[] = [];
  const local = controls(calls);
  const f = fixture(local);
  for (const content of ["/sessions", "/auth", "/login", "/logout", "/profile", "/profile list", "/profile create work"]) {
    assert.equal(value(await f.bridge.request({ type: "slash", content })).kind, "text");
  }
  for (const content of ["/profile create ../escape", "/profile select WORK", "/profile select", "/profile list extra"]) await f.bridge.request({ type: "slash", content });
  assert.deepEqual(calls, ["work"]);
  assert.equal((await f.bridge.request({ type: "slash", content: "/auth", path: "/private" })).ok, false);
  local.selectProfile = async (name) => {
    assert.deepEqual(f.calls, ["dispose"]);
    assert.equal((await f.bridge.request({ type: "send", content: "never" })).ok, false);
    calls.push(`select:${name}`);
  };
  assert.equal(value(await f.bridge.request({ type: "slash", content: "/profile select work" })).kind, "restart");
  assert.deepEqual(calls, ["work", "close-auth", "select:work"]);
  assert.equal((await f.bridge.request({ type: "create" })).ok, false);
});
test("desktop local failures redact details and output is bounded", async () => {
  const local = controls([]); const f = fixture(local);
  local.auth = async () => { throw new Error("private access_token=fixture-secret"); };
  const failed = await f.bridge.request({ type: "slash", content: "/auth" });
  assert.equal(failed.ok, false); assert.doesNotMatch(JSON.stringify(failed), /fixture-secret/);
  local.profiles = async () => "public profile\n".repeat(10000);
  assert.equal(value(await f.bridge.request({ type: "slash", content: "/profile" })).text.length, 32000);
  await f.bridge.close();
});
test("real profile and session stores stay host-bound, return only public metadata; pending login cancels on logout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-slash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profiles = createDragonsProfileStore({ configPath: join(directory, "config.json") });
  const sessions = createSessionStore(join(directory, "sessions"));
  const saved = await sessions.create({ workingDirectory: directory, provider: "local", model: "fixture" });
  await sessions.create({ workingDirectory: "/other", provider: "local", model: "fixture" });
  let loggedOut = 0; let aborted = false;
  const { controls: local } = createDesktopLocalControls({
    profiles, profileName: "default", sessions, workingDirectory: directory, authOptions: {},
    createAuth: (options) => ({
      credentials: { getValidCredentials: async () => { throw new Error("unused"); } },
      status: async () => ({ authenticated: false, storage: "/private/credential/path" }),
      logout: async () => { loggedOut++; },
      login: async () => {
        options.write?.("private-token-must-not-be-displayed");
        options.write?.("Code:\nABCD-1234\n\n");
        try { await options.sleep?.(60000); } catch { aborted = true; throw new Error("aborted"); }
      },
    }),
  });
  const output = await local.sessions(); assert.match(output, new RegExp(saved.id)); assert.equal(output.split("\n").length, 1); assert.doesNotMatch(output, new RegExp(directory));
  assert.match(await local.createProfile("work"), /work/);
  assert.equal(await profiles.active(), "default");
  assert.match(await local.login(), /ABCD-1234/);
  assert.doesNotMatch(await local.auth(), /private/);
  await local.logout(); assert.equal(aborted, true); assert.equal(loggedOut, 1);
  assert.equal(await local.auth(), "Not signed in.");
  await local.close(); await local.selectProfile("work"); assert.equal(await profiles.active(), "work");
  await assert.rejects(local.login());
});

test("desktop device flow uses real auth service with injected transport and never returns stored credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let saved: CodexCredentials | undefined;
  let completed!: () => void;
  const completion = new Promise<void>((resolve) => { completed = resolve; });
  const { controls: local } = createDesktopLocalControls({
    profiles: createDragonsProfileStore({ configPath: join(directory, "config.json") }),
    profileName: "default", sessions: createSessionStore(join(directory, "sessions")), workingDirectory: directory,
    authOptions: {
      credentialStore: {
        load: async () => saved,
        save: async (credentials) => { saved = credentials; completed(); },
        remove: async () => { saved = undefined; }, storageDescription: async () => "fixture-memory",
      },
      fetchImpl: async (url) => {
        const path = String(url);
        return Response.json(path.endsWith("/usercode") ? { user_code: "TEST-1234", device_auth_id: "fixture-device" }
          : path.endsWith("/deviceauth/token") ? { authorization_code: "fixture-authorization", code_verifier: "fixture-verifier" }
          : { access_token: "fixture-private-access", refresh_token: "fixture-private-refresh", expires_in: 3600, token_type: "Bearer" });
      },
    },
    createAuth: (options) => createChatGPTAuthService({ ...options, sleep: async () => {} }),
  });
  assert.match(await local.login(), /TEST-1234/);
  await completion;
  // Await the auth-service completion microtasks, not a timer or network.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await local.auth(), "Signed in to ChatGPT Subscription.");
  assert.equal(saved?.accessToken, "fixture-private-access");
  await local.logout(); assert.equal(saved, undefined);
  await local.close();
});

test("desktop closing interrupts initial login fetch before any challenge or credential mutation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-auth-close-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let started!: () => void;
  const fetching = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const { controls: local } = createDesktopLocalControls({
    profiles: createDragonsProfileStore({ configPath: join(directory, "config.json") }),
    profileName: "default", sessions: createSessionStore(join(directory, "sessions")), workingDirectory: directory,
    authOptions: {
      credentialStore: { load: async () => undefined, save: async () => assert.fail("no save"), remove: async () => {}, storageDescription: async () => "fixture" },
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("private transport detail")); }, { once: true });
        started();
      }),
    },
  });
  const f = fixture(local);
  const login = f.bridge.request({ type: "slash", content: "/login chatgpt" });
  await fetching;
  await f.bridge.close();
  assert.equal(aborted, true);
  assert.equal((await login).ok, false);
  assert.deepEqual(f.calls, ["dispose"]);
});
