import { loginSetup } from "../slash-choices.js";
import { isApiKeyProvider, isApiKeySlot, type ApiKeyAuth, type SecretPrompt } from "../provider/api-key-auth.js";
import type { ChatGPTAuthService } from "../provider/codex-auth.js";
import type { DragonsProfileStore } from "../profiles.js";
import type { SessionStore } from "../session-store.js";

export type TuiLocalCommandContext = { requestSecret?: SecretPrompt; notice(text: string): void; signal: AbortSignal; session?: { provider: string; model: string } };
/** Explicit trusted-host injection. Never constructed from remote runtime metadata. */
export type TuiLocalCommands = {
  names: readonly string[];
  execute(command: string, context: TuiLocalCommandContext): Promise<{ exit?: boolean } | void>;
};

/** Accept only the device-flow presentation, never arbitrary auth output/errors. */
export function safeTuiAuthNotice(text: string): string | undefined {
  if (text === "ChatGPT Subscription (Experimental)\n\n") return "ChatGPT Subscription (Experimental)";
  if (text === "Waiting for authentication...\n") return "Waiting for authentication…";
  if (text === "✓ Signed in\n") return "Signed in.";
  if (/^Open this page:\nhttps:\/\/auth\.openai\.com\/codex\/device\n\n$/.test(text)) return text.trim();
  if (/^Code:\n[A-Z0-9-]{4,32}\n\n$/.test(text)) return text.trim();
  return undefined;
}

export function createTuiLocalCommands(options: {
  apiKeyAuth?: ApiKeyAuth;
  auth: Pick<ChatGPTAuthService, "login" | "status" | "logout">;
  profiles: DragonsProfileStore;
  sessions: SessionStore;
  /** Routes service output only while login is active. */
  reasoning?: (provider: string, model: string, level?: string) => Promise<string>;
  authNotices?: (notice?: (text: string) => void, signal?: AbortSignal) => void;
}): TuiLocalCommands {
  return {
    names: [...(options.reasoning ? ["/reasoning"] : []), "/login", "/logout", "/auth", "/profile", "/sessions"],
    async execute(command, context) {
      const [name, ...args] = command.split(/\s+/);
      if (context.signal.aborted) return;
      if (name === "/reasoning" && options.reasoning) {
        if (!context.session) { context.notice("Create a session first."); return; }
        if (args.length > 1) { context.notice("Usage: /reasoning [default|level]"); return; }
        try { context.notice(await options.reasoning(context.session.provider, context.session.model, args[0])); }
        catch { context.notice("Unable to set reasoning: unsupported level or profile could not be saved."); }
      } else if (name === "/sessions" && args.length === 0) {
        const sessions = await options.sessions.list();
        context.notice(sessions.slice(0, 100).map((session) => `${session.id}  ${session.provider} · ${session.model}`).join("\n") || "No saved sessions.");
      } else if (name === "/login" && args.length === 2 && args[0] === "list" && isApiKeyProvider(args[1]) && options.apiKeyAuth?.list) {
        const slots = await options.apiKeyAuth.list(args[1]);
        context.notice(slots.length ? slots.map(({ slot, state }) => `${slot}: ${state}`).join("\n") : "No named API-key slots.");
      } else if (name === "/login") {
        if ((args.length === 1 || (args.length === 2 && isApiKeySlot(args[1]))) && isApiKeyProvider(args[0]) && options.apiKeyAuth && context.requestSecret) {
          const saved = args[1] === undefined
            ? await options.apiKeyAuth.login(args[0], context.requestSecret, context.signal)
            : options.apiKeyAuth.add
              ? await options.apiKeyAuth.add(args[0], args[1], context.requestSecret, context.signal)
              : false;
          context.notice(saved ? "API key saved in profile OS credential storage. Restart Dragons to use it. Provider access not yet verified." : "API-key sign-in cancelled or slots unavailable.");
          if (saved) return { exit: true };
          return;
        }
        const setup = args.length > 1 ? "Usage: /login <provider>. Never include credentials." : loginSetup(args[0]);
        if (setup) { context.notice(setup); return; }
        options.authNotices?.((text) => { const safe = safeTuiAuthNotice(text); if (safe) context.notice(safe); }, context.signal);
        try { await options.auth.login({ signal: context.signal }); context.notice("ChatGPT Subscription: signed in."); }
        finally { options.authNotices?.(); }
      } else if (name === "/logout" && args.length === 2 && isApiKeyProvider(args[0]) && isApiKeySlot(args[1]) && options.apiKeyAuth?.remove) {
        await options.apiKeyAuth.remove(args[0], args[1]);
        context.notice("Named API-key slot removed. Restart Dragons to clear cached credentials.");
        return { exit: true };
      } else if (name === "/logout" && args.length <= 1) {
        const provider = args[0] ?? context.session?.provider ?? "chatgpt";
        if (isApiKeyProvider(provider) && options.apiKeyAuth) {
          await options.apiKeyAuth.logout(provider);
          context.notice("Provider API key removed. Environment credentials, if configured externally, remain unchanged.");
          return { exit: true };
        }
        if (provider !== "chatgpt") { context.notice("This provider has no supported stored login."); return; }
        await options.auth.logout();
        context.notice("ChatGPT Subscription: signed out.");
        // Dispose credential-bearing provider instances rather than retaining cached credentials.
        return { exit: true };
      } else if (name === "/auth") {
        const selectors = args[0] === "status" ? args.slice(1) : args;
        const provider = selectors[0] ?? context.session?.provider ?? "chatgpt";
        if (selectors.length > 1 || !(provider === "chatgpt" || provider === "local" || isApiKeyProvider(provider))) {
          context.notice("Usage: /auth [status] [provider]. Never include credentials.");
          return;
        }
        if (provider === "local") { context.notice("Local models require no login."); return; }
        let notice: string;
        if (isApiKeyProvider(provider)) {
          if (!options.apiKeyAuth) { context.notice("API-key storage unavailable."); return; }
          const stored = Boolean(await options.apiKeyAuth.credentials(provider));
          notice = `${provider}: ${stored ? "API key stored in profile OS credential storage" : "No API key stored in profile OS credential storage"}. Provider access and environment credentials not checked.`;
        } else {
          const status = await options.auth.status();
          notice = status.authenticated ? "ChatGPT Subscription: signed in." : "ChatGPT Subscription: not signed in. Run /login chatgpt.";
        }
        if (!context.signal.aborted) context.notice(notice);
      } else if (name === "/profile") {
        if (args.length === 0 || args.join(" ") === "list") {
          context.notice(`Active profile: ${await options.profiles.active()}\nProfiles: ${(await options.profiles.list()).slice(0, 100).join(", ")}`);
        } else if (args.length === 2 && args[0] === "create") {
          const profile = await options.profiles.create(args[1]!);
          context.notice(`Profile created: ${profile.name}`);
        } else if (args.length === 2 && args[0] === "select") {
          await options.profiles.select(args[1]!);
          context.notice("Profile selected. Restart Dragons to open its isolated state and credentials.");
          return { exit: true };
        } else context.notice("Usage: /profile [list|create <name>|select <name>]");
      } else context.notice("Invalid command arguments. Run /help.");
    },
  };
}
