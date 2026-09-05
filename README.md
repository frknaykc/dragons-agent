# Dragons Agent

[![npm version](https://img.shields.io/npm/v/dragons-agent?logo=npm&label=npm)](https://www.npmjs.com/package/dragons-agent)
[![npm downloads](https://img.shields.io/npm/dm/dragons-agent?logo=npm&label=downloads)](https://www.npmjs.com/package/dragons-agent)
[![CI](https://github.com/frknaykc/dragons-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/frknaykc/dragons-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/frknaykc/dragons-agent)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/frknaykc/dragons-agent?style=flat)](https://github.com/frknaykc/dragons-agent)

Dragons Agent is a terminal-native AI coding agent. Its own local runtime owns the agent loop, workspace tools, authorization decisions, sessions, and extensions rather than delegating those controls to a provider client.

**Status:** early public release — **v0.1.0**.

<p align="center">
  <img src="docs/assets/dragons-cli.png" alt="Dragons Agent interactive CLI showing the banner and a single inline prompt." width="960">
</p>
<p align="center"><sub>Sanitized deterministic capture of the current interactive CLI, rendered through the real runtime with no provider credentials or workspace data.</sub></p>

## Installation

Dragons requires **Node.js 22 or newer**.

```sh
npm install -g dragons-agent
dragons
```

## Quick start

### ChatGPT Subscription — Experimental

```sh
dragons auth login --provider chatgpt
dragons --provider chatgpt
```

This opens Dragons-owned browser/device authentication and stores Dragons' authentication state using native credential storage where supported.

### OpenAI Platform API

```sh
OPENAI_API_KEY=... dragons --provider openai-api
```

Use a real key only in your shell or secret manager; never put it in source, a prompt, a Memory record, or an issue.

## Interactive CLI

Run `dragons` without a task to start an interactive session. Run `dragons --help` for the top-level command families and `/help` inside the CLI for local commands.

Useful examples:

```text
/status
/diagnostics
/sessions
/resume <id>
/skills list
/memory list
/mcp list
/plan list
```

Press **Ctrl+C** to cancel an active run. Sessions can also be managed outside the interactive UI:

```sh
dragons session list
dragons session resume <id>
```

## Full-screen TUI v2

The opt-in TUI is a client of the public Dragons runtime API, not a second agent loop. The existing line-oriented CLI and headless commands are unchanged.

```sh
dragons --tui
dragons --tui --provider local --model <installed-model>
dragons --tui --resume <session-id>
```

Place `--tui` first. Provider/model defaults come from the same Dragons configuration as the CLI; resume uses the saved provider and model and rejects overrides. Both stdin and stdout must be terminals. With redirected streams, omit `--tui` to use the plain CLI; requesting full-screen mode fails without emitting terminal escapes or creating a session.

- **Enter** sends the draft; **Left/Right**, **Home/End** (or Ctrl+A/Ctrl+E), **Backspace/Delete** edit grapheme-aware text. Bracketed paste inserts text and never submits or approves a request. Input is single-line, limited to 8,000 characters; pasted newlines become spaces.
- **Tab** switches conversation/activity views. **Page Up/Page Down** scroll the selected view. **Ctrl+R** refreshes session and background status.
- A permission panel shows the pending operation, tool, and request ID. **Deny is selected initially**; **Tab** chooses Allow once and **Enter** confirms. Each decision is tied to that exact runtime run/request. The TUI does not offer persistent/session grants, expose raw tool arguments, or bypass `runAgent()` authorization. Cancel if the shown information is insufficient to approve.
- **Esc** or **Ctrl+C** cancels the current run. **Ctrl+C** while idle or **Ctrl+D** exits. Exit/EOF and catchable SIGINT/SIGTERM/SIGHUP restore raw mode, cursor, bracketed paste and alternate screen. SIGKILL cannot run cleanup.
- Resizing preserves the draft and client state. Below **25 columns × 9 rows**, only a resize notice is shown and approvals are disabled. Display width uses grapheme segmentation and Unicode cell widths; ambiguous-width glyphs assume narrow rendering.

The conversation has one assistant slot per run, updated during streaming and reconciled with the final runtime result without duplication. Retention is bounded to 100 messages (16,000 characters each) and 50 tool-activity entries (2,000 characters each); intermediate assistant text is replaced by the final result. Terminal control sequences are stripped from all displayed content. Output rendering is coalesced and respects writable-stream backpressure.

Status includes provider/model, session ID, runtime activity, context budget, and the plan-task count exposed by the runtime. The activity view includes structured tool/subagent activity and runtime-owned background-task summaries; Ctrl+R refreshes background status. This milestone does not add plan editing or background-task launch controls. Resume retains the runtime's saved continuation, but does **not** display prior transcript bodies because the public runtime API intentionally does not return them. Use the existing CLI for its broader session/plan/MCP commands. Memory suggestions are explicitly rejected with a notice; accepting suggestions is not supported by this TUI.

Local deterministic verification (no live provider inference):

```sh
pnpm build
node --test dist/tui-controller.test.js dist/tui-screen.test.js dist/tui-terminal.test.js
python3 scripts/verify-tui-pty.py  # POSIX PTY fixture; not a native-emulator visual test
```

## Desktop foundation

The source-checkout desktop client uses a small Electron shell with plain local HTML/CSS/JavaScript, rather than a UI framework or a second agent engine. Electron is a **development-only** dependency; this milestone does not ship an installer or change the CLI package's installation requirements.

```sh
pnpm install --frozen-lockfile
pnpm desktop
# To choose a different trusted workspace after building:
# cd /path/to/workspace
# /path/to/DragonsAgent/node_modules/.bin/electron /path/to/DragonsAgent/desktop/main.mjs
pnpm acceptance:desktop  # actual local window; deterministic provider, no live inference
```

Launch uses the working directory as the immutable workspace. Configure credentials through existing host-side provider authentication/configuration, not the window. Choose **Host default** to use configured provider/model/limits, or select an explicit provider/model; create a session or resume its ID, send a request, observe streamed text and tool activity, allow once/deny the exact pending operation, or cancel. Resume restores saved continuation, not prior message display. Provider/model changes apply to new sessions only.

The sandboxed renderer has no Node integration. Its isolated preload exposes only validated runtime commands and a bounded event drain. Only the exact local main frame may invoke them; there is no filesystem, shell, credential, or arbitrary Electron RPC. The main process owns the M71 runtime and existing workspace/authorization boundary. All content uses text nodes; scripts, navigation, popups, webviews, permissions and external network/content are blocked in the renderer. The event queue is capped at 256 events / 512 Ki characters and disconnects/cancels on overflow; the UI retains at most 80 messages of 32,000 characters and 16,000 activity characters. Closing/crashing the window cancels and disposes its runtime. Memory suggestions are explicitly rejected; plan/background editing and automatic MCP connection are outside this foundation.

Deterministic bridge tests run on all CI platforms without a GUI. `acceptance:desktop` separately exercises the actual Electron window, sandbox/preload, configured model defaults, inert model content, streaming, real isolated write allow/deny, cancellation, resume and reload cleanup. Reload is a fail-closed disconnect: the window closes and cancels its run; reopen and resume explicitly. Neither test path establishes live provider acceptance.

## Web / remote runtime foundation

`dragons-agent/remote/server` exports `startRemoteServer`; `dragons-agent/remote/client` exports the browser-compatible `RemoteClient` (fetch + SSE, no Node imports in emitted client JavaScript). This is a protocol/SDK foundation, not a hosted website or permission to publish a local agent to the internet. The source-checkout `pnpm remote` launcher requires a host-provided random base64url `DRAGONS_REMOTE_TOKEN` (32–256 characters), prints only its loopback URL, and uses the launch workspace and existing host configuration. Never put transport tokens in URLs, command arguments, source, browser storage or logs.

The trusted server receives `principals: [{id, token, sessionIds?}]` and a `createRuntime(principalId, connectionId)` factory (existing single-argument factories remain compatible). The factory must create isolated runtimes, or return shared-host client facades, in a workspace/store authorized for that principal. Provider credentials and arbitrary dependencies never cross the protocol. It binds **only `127.0.0.1`**, on an ephemeral port by default; there is no public bind option. Remote access requires a separately secured channel such as authenticated SSH forwarding. TLS termination, public deployment and a web UI are not included.

Protocol:

1. `POST /connect` with JSON `{}` and `Authorization: Bearer <transport-token>` obtains a fresh `connectionId`. One connection per principal; a competing connection fails rather than taking over.
2. Open `GET /events` with bearer plus `x-dragons-connection`. This SSE stream must exist before sending input. Runtime events are structured `data: <JSON>` frames; no terminal parsing or automatic event replay.
3. `POST /command` uses the same headers, JSON content type, and `{sequence, command}`. Sequence starts at 1, must be exactly next, and is consumed before asynchronous execution. Commands are `providers`, `create`, `resume`, `status`, `background`, `send`, `approve`, `cancel`; the desktop bridge's strict command schema also applies remotely. Approvals require exact session/run/pending approval ID and only `allow_once` or `deny`.
4. `DELETE /connection`, lost event stream, slow-consumer overflow or shutdown cancels/disposes the owned bridge. Reconnect creates a new connection/sequence space and may resume an owned saved session. It never resumes an approval or retries a lost command. After an ambiguous failure, inspect persisted state before deciding whether to submit new input.

`RemoteClient.connect({url, token, onEvent})` opens both transports; `request(command)` returns `{ok,value}` or a bounded error envelope; `close()` disconnects and `disconnected` signals teardown. Client commands are ordered with a bounded queue; lost replies are **not retried**. The host remembers created-session ownership across reconnects within its lifetime (up to 128 per principal). After restart, only the trusted host may supply `sessionIds` to restore access; knowing an ID is not authorization.

Security: exact Host header; authentication on every operational endpoint; no cookie/query authentication; no wildcard CORS. Browser Origin is rejected by default. Explicit `allowedOrigins` enables exact-origin CORS and an unauthenticated, rate-bounded OPTIONS preflight exposing only fixed protocol metadata. There is no filesystem/shell RPC. Bounds include 32 principals/connections, 64 sockets/in-flight HTTP requests, 8 in-flight requests per principal, 256 KiB request/reply bodies, 64 KiB event frames, header/time limits, token-bucket request rates and disconnect-on-SSE-backpressure. Transport shutdown is bounded, but an unresolved runtime disposal retains ownership rather than allowing an unsafe replacement. Deterministic tests use actual local sockets and the existing runtime/tools, not external infrastructure or live models.

## Multi-client sessions

`dragons-agent/shared-runtime` exports `createSharedRuntimeHost(core)`. The trusted host exclusively owns that core; `host.connect(clientId)` returns an isolated client facade and `host.close()` disposes the whole host. Client IDs are identities, **not credentials**: the embedding host/remote transport authenticates and authorizes workspace/session access. Do not hand the underlying core to independent writers alongside the shared host.

The remote server still defaults to one connection per principal. Trusted shared-host compositions may set `maxConnectionsPerPrincipal` from 1 to 8; each connection gets its own bridge, identity, stream, sequence and approval authority. The source-checkout `pnpm remote` launcher now uses this shared composition with eight slots. It does not restore session authorization automatically after a host restart; embeddings explicitly provide owned `sessionIds` when restart recovery is needed.

To attach the existing CLI/TUI or desktop to the same running host, provide its `DRAGONS_RUNTIME_URL` and `DRAGONS_REMOTE_TOKEN` in their **trusted process environments**, then launch `dragons --tui` (or `pnpm dragons --tui`) and `pnpm desktop`. Tokens never enter the desktop renderer. Omit the URL for the unchanged standalone paths. Use `dragons --tui --resume <id>` / desktop **Resume** for the same session. Explicit CLI provider/model selectors apply to newly created remote sessions; remote host defaults, not local CLI defaults, otherwise apply. `dragons-agent/remote/runtime` also exports `connectRemoteRuntime({url,token})`, the presentation-only runtime facade used by both clients.

- **One foreground owner per session.** Admission is reserved before asynchronous work. A concurrent sender is rejected, not queued or silently overwritten. Status adds `shared: {clientId, revision, ownerClientId?}`; foreground admission and settlement advance the host-local revision. A client whose acknowledged revision is stale must refresh status or resume before another write. This is foreground admission control, not a new persisted session format or a distributed database revision.
- **Observe without taking control.** Resume during a run or refresh an attached idle client (TUI **Ctrl+R**, desktop **Refresh status**) attaches a bounded live observation. Early transcript text is unavailable and a truncation notice is emitted. Observation does not grant cancellation or approval rights; pending approval IDs are not broadcast to observers. Only the owner may approve/deny the exact current request, once. Session-wide approvals are not offered by shared facades. Other sessions retain their own provider/model/state.
- **Detach and reconnect.** An observer disconnect/overflow closes only its observation; it cannot stop the owner. An owner disconnect cancels its run; ownership remains reserved until admission, provider unwind, persistence and cleanup settle. A new connection can resume after that cleanup but cannot inherit the old run/approval. Host shutdown cancels all foreground work and disposes the core. No automatic command replay or ownership takeover occurs.
- **State visibility.** Status includes the same session summary, plan-task count and context budget; the existing structured event stream includes tool/subagent activity. `background` / `listBackgroundTasks` returns bounded session-scoped metadata. Host-started read-only background work remains visible after a client detaches and ends on host shutdown; observation never transfers background cancellation authority. The TUI/desktop remote facade does not add MCP administration, background launch or memory-write controls.
- **Resource bounds.** Shared hosts allow 32 client identities and 128 retained session entries; each subscription has at most 128 queued events / 512 KiB and 128 pending reads. Slow observers detach; slow owners cancel rather than buffer indefinitely. The remote facade has its own bounded single-reader stream. Core foreground active/admitting work is capped at 128.
- **Separate-process safety.** The default file session store uses an independent exclusive execution lease, held across continuation reload, provider/tool work and final persistence. Runtime and persisted interactive CLI runs acquire it before execution; short plan/session mutation locks remain independent. Competing processes fail closed. A crash can leave an execution lock; it is never stolen automatically, even if its recorded PID looks stale. Recovery is an explicit operator action only after confirming all writers have stopped. Custom injected stores must implement `acquireExecution` or supply equivalent trusted external coordination for cross-process use.

Verification uses deterministic local models, real HTTP/SSE, real POSIX PTYs and an actual Electron window:

```sh
pnpm build
node --test dist/shared*.test.js dist/session-execution-lease.test.js dist/runtime-admission-cap.test.js
python3 scripts/verify-tui-pty.py --shared
pnpm exec electron scripts/verify-desktop-smoke.mjs --shared
```

The shared GUI acceptance exercises both TUI-owner/desktop-observer and desktop-owner/TUI-observer directions, approvals, cancellation, resume and reload cleanup. It is not live inference or a desktop installer/cross-platform visual certification. CLI plan editing and host-managed background/MCP workflows remain available through their established authoritative paths, not through new privileged renderer RPCs.

## Providers

### OpenAI Platform API

- Uses the standard OpenAI API and requires `OPENAI_API_KEY`.
- Platform usage is billed separately by OpenAI.
- The implementation has deterministic coverage. Live provider acceptance is deliberately opt-in and requires a locally available API key.

### ChatGPT Subscription — Experimental

- Uses browser/device authentication and Dragons-owned authentication state.
- Uses the experimental Codex-compatible transport implemented by Dragons.
- Native credential storage is used where supported, with a restrictive local fallback.
- Compatibility can change because this transport is implementation-specific. It is not a claim of official OpenAI support for Dragons as a third-party subscription client.

### Anthropic, Google Gemini, and OpenRouter

- `anthropic` uses the Anthropic Messages API with `ANTHROPIC_API_KEY`.
- `gemini` uses Google Gemini Generate Content with `GEMINI_API_KEY`.
- `openrouter` uses OpenRouter Chat Completions with `OPENROUTER_API_KEY`.
- These adapters support streamed text and tool-result continuation through the same runtime authorization boundary. Tool support depends on the selected model; an unsupported tool request fails explicitly rather than bypassing authorization. Authenticated endpoints require HTTPS.

### Local Model — OpenAI-compatible

`local` connects to an already-running OpenAI-compatible Chat Completions server, such as Ollama or vLLM. It does not install a runtime or download a model. Select a model available on your server with tool-calling support for coding runs.

```sh
dragons config set-local-endpoint http://127.0.0.1:11434/v1
dragons config set-model local qwen2.5-coder:7b
dragons --provider local
```

The default base endpoint is `http://127.0.0.1:11434/v1`; Dragons appends `/chat/completions`. `set-local-endpoint` validates and persists the `localEndpoint` configuration field. Configured URLs must be credential-free HTTPS or HTTP on literal loopback (`127.0.0.1` or `[::1]`); remote plain HTTP and `http://localhost` are rejected. URL user information, query parameters, and fragments are rejected.

The Local adapter has no API-key or environment-credential fallback and sends no Authorization header, including to an explicitly configured HTTPS endpoint. A remote HTTPS endpoint receives the selected project context just like any other chosen provider. Local continuation state is provider-tagged and isolated from OpenRouter state; WRITE and EXECUTE still require runtime approval.

Local coverage uses deterministic transports for configuration, streaming/tool continuation, malformed responses, cancellation, and state isolation. This is not a claim of live Ollama or vLLM inference acceptance. Live provider checks remain opt-in and require the corresponding credentials or an installed, running model.

### Provider and model defaults

Set local defaults with:

```sh
dragons config show
dragons config set-provider <provider>
dragons config set-model <provider> <model>
```

| Provider ID | Built-in default model |
| --- | --- |
| `openai-api` | `gpt-4.1-mini` |
| `chatgpt` | `gpt-5.6-terra` |
| `anthropic` | `claude-sonnet-5` |
| `gemini` | `gemini-2.5-flash` |
| `openrouter` | `openai/gpt-4.1-mini` |
| `local` | `qwen2.5-coder:7b` |

A configured model overrides its provider default; `--model` overrides the configured choice for a run. Built-in model names are configuration defaults, not guarantees of account or server availability.

## Features

- Interactive and one-shot coding runs with streamed responses
- Workspace-bounded file reads, search, symbol navigation, unified-diff patch editing, and shell execution
- Repository intelligence, heuristic test recommendations, Git awareness, and current-run change self-review
- Explicit READ, WRITE, and EXECUTE permissions
- Persistent sessions and bounded context handling
- Explicit local Skills and local user/project Memory
- Bounded plans, one-level subagents, read-only process-local tasks, and explicitly created persistent read-only jobs
- Official-SDK, explicitly activated **stdio** and Streamable HTTP MCP connections
- Local runtime diagnostics

## Safety & permissions

Dragons classifies tools before they run:

- **READ** tools inspect workspace or runtime information and do not prompt by default.
- **WRITE** tools can change project files and require explicit approval.
- **EXECUTE** tools can run commands or external capabilities and require explicit approval.

Authorization fails closed: a missing, denied, or cancelled approval does not run a WRITE or EXECUTE operation. You can approve one operation or grant a scoped, process-local session approval. Resumed and new sessions do not inherit those approvals.

Approved shell and tool calls can affect the machine or project you selected. Review each approval request deliberately.

## Sessions

Interactive runs create persistent local sessions. Use `/sessions` and `/resume <id>` in the CLI, or `dragons session list` and `dragons session resume <id>` from the shell. Session approvals remain process-local and are not persisted.

## Skills

Skills are explicit, local advisory instructions stored in Dragons-owned local storage. A project can also provide explicitly selected Skills at `.dragons/skills/<skill-id>/SKILL.md`; discovery is direct-only, deterministic, bounded, and rejects symlinks or paths outside the workspace. Project Skills retain `PROJECT` provenance and remain advisory: they cannot override authorization, workspace boundaries, or system/provider policy. Multiple selected Skills compose in explicit activation order, with each bounded, labeled by `USER` or `PROJECT`, and retained across session resume; a same-name user and project Skill remain distinct (`USER:<id>` and `PROJECT:<id>`). Use `dragons skills list`, `dragons skills show <id> project`, and `dragons skills activate|deactivate <id> project --session <id>` (or `/skills activate|deactivate project <id>` interactively). Dragons does not provide a Skills marketplace.

## MCP

Dragons uses the official MCP SDK for explicitly configured **stdio** and Streamable HTTP servers. External MCP servers should be trusted deliberately. Dragons keeps authorization authoritative over exposed MCP tools; external tools default conservatively to `EXECUTE` unless configuration classifies them more narrowly.

Existing stdio entries remain valid. Add an HTTP server with an explicit transport and endpoint:

```json
{
  "mcpServers": [
    { "id": "local-tools", "command": "node", "args": ["server.mjs"] },
    { "id": "remote-tools", "transport": "http", "url": "https://mcp.example.test/mcp" },
    { "id": "private-tools", "transport": "http", "url": "https://private.example.test/mcp", "auth": { "type": "bearer", "credentialId": "private-tools" } }
  ]
}
```

HTTP endpoints must be `http` or `https`, must not contain credentials, fragments, or query parameters, and redirects are rejected. HTTP bearer auth is opt-in and reads a token only from Dragons native credential storage, scoped by server ID, origin, and credential ID. Tokens and raw headers are rejected in configuration, command arguments, diagnostics, status output, sessions, and errors. The current CLI deliberately has no token argument or plaintext-file fallback; interactive OAuth and credential provisioning are not implemented. MCP connection, discovery, and invocation work is time-bounded; each HTTP response is capped at 1 MiB; automatic reconnect is disabled. `dragons mcp status` reports safe transport, auth mode, lifecycle, bounded tool/resource/prompt counts, namespaced tool identities, timing, and failure-category metadata without exposing endpoints or secrets.

Use `dragons mcp list`, `dragons mcp connect <id>`, `dragons mcp connect-all`, `dragons mcp status`, and `dragons mcp disconnect <id>` after adding valid non-secret server configuration to Dragons' local config. `/mcp connect-all` provides the same process-local interactive behavior. Dragons accepts up to eight configured MCP servers, connects at most two at once, namespaces every exposed tool by server ID, and caps the combined active MCP tool set at 128. A failed server remains isolated; connected servers and their authorization requirements stay active.

## Memory

Memory is explicit, local, and user- or project-scoped. Dragons does not automatically learn or silently write Memory, and it does not use a vector database or RAG system. For a task, it deterministically selects at most eight matching USER/current-project records (at most 8,000 body characters) with case-insensitive lexical matching; unrelated and other-project records are excluded, and the resulting context remains advisory-only. A model may create a bounded pending suggestion, but it is shown verbatim and remains process-local until the user explicitly accepts it with `/memory accept <suggestion-id>`; `/memory reject <suggestion-id>` or process exit leaves nothing stored. `dragons memory suggest [user|project] <body>` is non-interactive and displays an unpersisted candidate only. Suggestions reject credential-shaped values, code blocks, and oversized content. Manage saved records with `dragons memory list`, `dragons memory add`, `dragons memory show`, and `dragons memory delete`.

## Planning, subagents, and background tasks

Plans are bounded, explicit session-local tasks. Subagents are one-level only and receive a restricted read-only tool snapshot; they cannot recursively create teams. `/tasks` remains read-only and process-local: its state and continuation do not survive process exit. `/jobs start <task>` creates a separate read-only persistent job; `/jobs`, `/jobs show <id>`, `/jobs cancel <id>`, `/jobs resume <id>`, and `/jobs cleanup` provide bounded management. Jobs enforce a bounded active count, duration, turns, output, and durable storage. Only bounded lifecycle metadata and redacted result summaries are durable; runtime handles, approvals, credentials, and tool registries are never stored. After a process exit, active persistent jobs reconcile once to `interrupted` and require explicit manual resume—Dragons never blindly retries them.

## Coding intelligence

v0.1.0 includes bounded repository intelligence, JavaScript/TypeScript symbol navigation, approval-gated unified-diff `apply_patch`, heuristic test recommendations, and Git/current-run self-review.

Current limitations:

- Symbol references are syntactic/lexical, not LSP or type-aware.
- Test selection is heuristic and does not perform dependency analysis.
- Multi-file patch validation occurs before writes, but application is not crash-transactional across files.

## Architecture

```text
CLI → Agent runtime → Provider → tool calls → authorization → tools → tool results → provider continuation
```

The provider-neutral runtime is event-driven: it owns ordered tool execution, authorization, cancellation, workspace boundaries, and bounded advisory context while emitting streamed text and tool lifecycle events. Providers supply model output and tool-call continuations through that runtime.

## Runtime API

The package also exposes the programmatic runtime facade from `dragons-agent` (or the explicit `dragons-agent/runtime` subpath). It is a structured client API over the existing `runAgent()` authorization boundary, not a provider-specific execution path.

```ts
import { createDragonsRuntime } from "dragons-agent";

const runtime = await createDragonsRuntime({ workingDirectory: process.cwd() });
const session = await runtime.createSession();
const run = await runtime.sendUserInput({ sessionId: session.id, content: "Inspect this project." });

for await (const event of run.events) {
  // assistant_delta, tool_activity, approval_requested, event_stream_truncated, run_completed, …
}
await run.result;
await runtime.dispose();
```

`providers()`, `createSession()`, `resumeSession()`, `status()`, and `sendUserInput()` return typed client-safe summaries. Transcript bodies, provider continuation state, tools, stores, raw arguments, model objects, and credentials are not exposed. WRITE and EXECUTE requests are surfaced as `approval_requested` events and must be resolved with `resolveAuthorization()`; the underlying `runAgent()` authorization boundary remains authoritative. A failed run rejects with a redacted `RuntimeRunError`, and cancellation emits `run_cancelled` rather than normal completion. A run event iterable is a single-consumer projection and must not be shared between clients. Each run caps both queued events and outstanding event requests at 256; an excess concurrent `next()` request resolves with `done`. When presentation events are dropped under backpressure, the client receives `event_stream_truncated` while interactive and terminal lifecycle events are retained.

MCP lifecycle is explicit and process-local: a trusted host may pass an existing `McpClientManager`, then call `connectMcp()` and `disconnectMcp()`. The runtime exposes safe status metadata only, never endpoints, credentials, raw errors, or remote descriptions; it closes only connections it opened when disposed. `startBackgroundTask()`, `listBackgroundTasks()`, and `cancelBackgroundTask()` provide explicit, session-bound, read-only process-local work with redacted summaries. Background task prompts, handles, approvals, and continuation state are never persisted or re-exposed. Disposal rejects late run admission, waits for pending MCP connections and releases their leases; concurrent disposal callers await the same cleanup.

Credential-shaped text is redacted incrementally across provider chunk boundaries, including quoted values and Basic/Bearer payloads. Incomplete tokens are buffered with a fixed bound; oversized tokens produce a visible truncation marker. Clients must concatenate `assistant_delta` text rather than assume provider chunk boundaries, and must not append the final result again to an already streamed answer. Redaction is not permission to render model/tool content as executable code.

## Diagnostics

Use `/diagnostics` during an interactive session for a concise local recent-run summary. Diagnostics are bounded and process-local.

## Security & data handling

To operate, Dragons may send selected project context, tool inputs, and tool results to the provider you choose. WRITE and EXECUTE operations require authorization. MCP servers are external processes and must be configured and trusted deliberately. Memory is local and explicitly recorded. Credentials use the current secure-storage implementation where available. The ChatGPT Subscription transport remains experimental.

This is not a legal privacy policy. See [SECURITY.md](SECURITY.md) for vulnerability reporting and boundary notes.

## Platform status

- **macOS:** live verified.
- **Linux:** deterministic coverage; no hosted live verification claimed.
- **Windows:** deterministic coverage; no hosted live verification claimed. POSIX process-group cleanup is stronger than Windows direct-child cleanup.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

For the local release gate, run `pnpm release:check`. Live provider acceptance is intentionally not part of normal tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## Roadmap

Future directions may include deeper coding intelligence, broader MCP support, Skills and Memory evolution, bounded autonomy, additional providers, and future clients. No dates are promised.

## License

MIT © 2026 Furkan "NaxoziwuS" Aykaç. See [LICENSE](LICENSE).
