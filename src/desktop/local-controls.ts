import { isApiKeyProvider, type ApiKeyAuth } from "../provider/api-key-auth.js";
import { setTimeout } from "node:timers/promises";
import { createChatGPTAuthService, type ChatGPTAuthService, type ChatGPTAuthServiceOptions } from "../provider/codex-auth.js";
import type { DragonsProfileStore } from "../profiles.js";
import type { SessionStore } from "../session-store.js";
import type { DesktopLocalControls } from "./bridge.js";

/** Host-only dependencies. Neither credential objects nor resolved paths cross IPC. */
export function createDesktopLocalControls(options: {
  apiKeyAuth?: ApiKeyAuth;
  profiles: DragonsProfileStore;
  profileName: string;
  sessions: SessionStore;
  workingDirectory: string;
  authOptions: ChatGPTAuthServiceOptions;
  createAuth?: (options: ChatGPTAuthServiceOptions) => ChatGPTAuthService;
}): { controls: DesktopLocalControls; auth: ChatGPTAuthService } {
  const secretController = new AbortController();
  let secretLogin: Promise<boolean> | undefined;
  let controller: AbortController | undefined;
  let login: Promise<void> | undefined;
  let notice = "";
  let ready: (() => void) | undefined;
  let closed = false;
  const auth = (options.createAuth ?? createChatGPTAuthService)({
    ...options.authOptions,
    // No browser capability is supplied to the renderer. The fixed device URL is displayed.
    openBrowser: () => false,
    write: (text) => {
      // Only the device challenge is public; never forward arbitrary auth-service output.
      const code = /^Code:\n([A-Za-z0-9-]{1,32})\n\n$/.exec(text);
      if (text.startsWith("Code:") && !code) throw new Error("Invalid device challenge.");
      if (code && !closed) {
        notice = `Open https://auth.openai.com/codex/device and enter code ${code[1]}. Run /auth chatgpt to check completion, or /logout chatgpt to cancel.`;
        ready?.();
      }
    },
    fetchImpl: async (input, init) => {
      const signal = controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) : undefined;
      signal?.throwIfAborted();
      const response = await (options.authOptions.fetchImpl ?? fetch)(input, { ...init, ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      return response;
    },
    sleep: async (milliseconds) => { await setTimeout(milliseconds, undefined, { signal: controller?.signal }); },
  });
  async function stopLogin() {
    controller?.abort();
    await login;
    controller = undefined;
    notice = "";
  }
  const controls: DesktopLocalControls = {
    ...(options.apiKeyAuth ? {
      async loginApiKey(provider, slot) {
        if (closed || secretLogin || login || !controls.requestSecret) throw new Error("API-key sign-in unavailable.");
        if (slot !== undefined) {
          if (!options.apiKeyAuth!.add) throw new Error("API-key slots unavailable.");
          secretLogin = options.apiKeyAuth!.add(provider, slot, controls.requestSecret, secretController.signal);
        } else secretLogin = options.apiKeyAuth!.login(provider, controls.requestSecret, secretController.signal);
        try { return await secretLogin; }
        finally { secretLogin = undefined; }
      },
      async listApiKeySlots(provider) {
        if (!options.apiKeyAuth!.list) throw new Error("API-key slots unavailable.");
        const slots = await options.apiKeyAuth!.list(provider);
        return slots.length ? slots.map(({ slot, state }) => `${slot}: ${state}`).join("\n") : "No named API-key slots.";
      },
      async removeApiKeySlot(provider, slot) {
        if (!options.apiKeyAuth!.remove) throw new Error("API-key slots unavailable.");
        await options.apiKeyAuth!.remove(provider, slot);
      },
    } : {}),
    async sessions() {
      const sessions = (await options.sessions.list()).filter((session) => session.workingDirectory === options.workingDirectory);
      return sessions.slice(0, 100).map((session) => `${session.id} · ${session.provider} · ${session.updatedAt}`).join("\n") || "No saved sessions in this workspace.";
    },
    async auth(provider = "chatgpt") {
      if (isApiKeyProvider(provider) && options.apiKeyAuth) {
        const stored = Boolean(await options.apiKeyAuth.credentials(provider));
        return `${provider}: ${stored ? "API key stored in profile OS credential storage" : "No API key stored in profile OS credential storage"}. Provider access and environment credentials not checked.`;
      }
      if (provider !== "chatgpt") return "This provider has no supported stored login.";
      const status = await auth.status();
      return login ? notice || "Sign-in pending. Run /auth or /logout to cancel." : status.authenticated ? "Signed in to ChatGPT Subscription." : notice || "Not signed in.";
    },
    async login() {
      if (closed) throw new Error("Closed");
      if (login) return notice || "Sign-in pending. Run /auth or /logout to cancel.";
      controller = new AbortController();
      notice = "";
      const started = new Promise<void>((resolve) => { ready = resolve; });
      login = Promise.resolve().then(() => auth.login({ signal: controller!.signal })).then(() => { notice = "Signed in to ChatGPT Subscription."; }, () => { notice = "Sign-in cancelled or failed. Run /login to retry."; }).finally(() => { login = undefined; ready?.(); ready = undefined; });
      await started;
      return notice;
    },
    async logout(provider = "chatgpt") {
      if (isApiKeyProvider(provider)) {
        if (!options.apiKeyAuth) throw new Error("API-key storage unavailable.");
        await options.apiKeyAuth.logout(provider);
        return "Provider API key removed. Environment credentials remain unchanged.";
      }
      if (provider !== "chatgpt") return "This provider has no supported stored login.";
      await stopLogin(); await auth.logout(); return "Signed out of ChatGPT Subscription.";
    },
    async profiles() { return `Current desktop profile: ${options.profileName}\n${(await options.profiles.list()).slice(0, 100).join("\n")}`; },
    async createProfile(name) { const profile = await options.profiles.create(name); return `Profile created: ${profile.name}`; },
    async selectProfile(name) { await options.profiles.select(name); },
    async close() { closed = true; secretController.abort(); await Promise.allSettled([secretLogin, stopLogin()]); },
  };
  return { controls, auth };
}
