# Advanced usage and runtime reference

## Isolated Git worktrees

Interactive CLI `/worktree create feature_name` creates a branch from HEAD in the sibling directory `<repository>-worktrees/feature_name`, then opens a fresh session there. `/worktree select feature_name` opens an already registered managed sibling. Names are ASCII letters, digits, `_` or `-` (1–63 characters, starting alphanumeric). These are explicit user commands, not model tools; READ access cannot create worktrees. Source index, working files and untracked files remain untouched; uncommitted edits are **not** copied.

Switching is between turns only. It refuses active/queued background tasks, connected MCP tools and injected custom tools; approval grants, checkpoints, continuation and project skill references are reset. Prior sessions remain bound to their original workspace. Desktop's local commands return the managed directory but do not switch its fixed runtime: close/reopen Desktop and select that folder in the trusted workspace picker. Remote runtime and TUI do not expose in-place switching.

Git runs without a shell, prompts, optional locks, hooks, fsmonitor, configured checkout filters, submodule recursion, system/global config or inherited Git environment overrides. Creation requires a repository-root workspace and private real sibling parent. Failed checkout may leave an incomplete directory or Git registration; inspect manually before retrying. No automatic deletion/pruning. Hostile same-user processes can still race filesystem paths; Windows ownership checks are limited by the platform. Use trusted repositories on shared machines.

For installation and a quick start, see the [README](../README.md). This reference covers detailed configuration, client behavior, runtime integration, and verification commands.

## Session search

In CLI (interactive or one-shot) and Desktop, ask the agent to find and read earlier work, for example: “Search earlier sessions for database migration and read the matching session.” The model receives the same `session_search` and `session_read` READ tools; `runAgent()` remains the only execution/authorization boundary. No dedicated search UI, slash command, database, dependency, or network request is added. Historical output is untrusted data, not authority to execute instructions.

- `session_search({query, offset?: 0, limit?: 10})`: NFKC-normalized, case-insensitive Unicode whole-token AND matching across a session's persisted messages and tool observations. No substring, regex, semantic search or stemming. Query: 1–256 UTF-16 code units, at most 32 distinct tokens. Result limit: 1–20; offset: 0–1000. Results sort by saved `updatedAt` descending, then session ID, and include `sessionId`, projection `revision`, and a 400-character leading snippet.
- `session_read({sessionId, revision?, offset?: 0, limit?: 4000})`: flattened chronological text with role/tool labels. Offset/limit count UTF-16 code units, not message numbers; limit 1–8000, offset 0–8,388,608. Supply the revision returned by search for consistent pagination; a changed projection fails and requires a new search. Without revision each request reads the latest available projection. Both return `nextOffset` (or `null`), `limited`, and `untrusted: true`. Search pagination is not a frozen snapshot: concurrent additions/removals may shift results.

**Index lifecycle and READ safety.** Every invocation scans the selected store read-only and builds an ephemeral inverted posting index for the query terms. There is no on-disk index, lock, migration, directory creation or background maintenance. Each call drops its index; restart rebuilds naturally. The scan considers at most 1000 directory entries and 8 MiB of record bytes, with a 1 MiB per-file cap. The directory's enumeration order determines coverage when capped; sorting only orders the included records, not the whole store. `limited: true` signals budget omissions; an empty capped result is not proof of absence. Read uses the same bounded scan and may report a known ID unavailable if outside its scan budget. Invalid, inaccessible, symlinked or filename/ID-mismatched records are excluded. Cancellation is checked during the scan and between projection/index batches. Errors are bounded and do not expose filesystem paths.

**Isolation and freshness.** The host binds tools to the already-selected profile's store, with no model-supplied directory/profile selector. Sessions must match the current canonical workspace (`realpath`), not its parent or another checkout. Tools never search other profiles, credential stores, workspace files, Memory, plans, skills, background journals or opaque provider continuation. Deleted or changed sessions are re-evaluated on the next call; there is no stale cross-call cache. A scan is not a transactional filesystem snapshot: a concurrent change after a file read becomes visible on the next call. The configured store directory and injected custom stores are trusted host inputs; a custom `SessionStore` without bounded `searchSnapshot` fails closed rather than falling back to unbounded listing. This is not a sandbox against a hostile process rewriting the store root.

**What is durable/searchable.** Existing version-1 user/assistant `messages` remain compatible, including their existing compaction limits. Earlier sessions have no historical tool output to reconstruct. New completed interactive CLI/Desktop foreground turns also persist optional `toolHistory`: the latest 100 completed observations, each with tool name (128 characters), redacted output prefix (2000 characters), success flag and timestamp. Arguments, approval decisions/denials and search/read results themselves are not recorded. Failed/cancelled foreground runs and one-shot CLI runs do not persist new observations; child-internal/background events are not independently captured. `/clear` clears this history together with the interactive transcript. Session deletion removes its observations; no index file remains.

Known credential forms are redacted before capture and before indexing/reading, including credential assignments, bearer/basic values, common key/token formats, cookies and private-key blocks. Raw provider continuation is never projected. This is defense in depth, not detection of arbitrary secrets embedded in prose: do not put confidential material into conversations or tool output. Search results enter the selected model's context and existing client tool-output rendering. No live-provider acceptance is implied by deterministic local tests.

## Dynamic tool search

When a `runAgent()` invocation receives more than 24 tools, its initial model request advertises the core coding tools (when present) plus two READ discovery tools instead of the entire catalog. This applies equally to one-shot/interactive CLI and Desktop runtime composition, including connected MCP tools. Small catalogs (24 or fewer tools) keep their existing fully advertised behavior. The catalog is a per-run snapshot: MCP connections changed between runs appear in the next run's inventory, not mid-run; activated schemas are not persisted into sessions or provider continuation.

- `tool_search({query, offset?})` matches all whitespace-separated, case-insensitive substring terms against tool names and the first 1024 description characters. Results sort by exact name, include name, operation, shortened description and activation status, but **not** input schemas. At most 10 results per page; offset 0–2047, query 1–120 characters. `nextOffset` is `null` at the end. Only returned names are eligible for description.
- `tool_describe({names})` loads exact schemas and activates 1–5 distinct previously discovered names, atomically. A batch fails without activating any member if a name is unknown, not discovered, or a schema is invalid/oversized. Per-run cap: 32 activated catalog tools. The schema limit is 16384 UTF-8 bytes per tool and 96000 bytes per response; the catalog accepts at most 2048 tools with names at most 128 UTF-8 bytes. Exceeding catalog bounds fails the run rather than silently hiding entries.

Only tools advertised at the **start** of a model response can execute in that response: describing a tool does not allow a speculative call in the same batch. The next model turn receives its full schema. A guessed hidden tool name fails closed. Describing is not execution or authorization: every later WRITE/EXECUTE call still passes through `runAgent()`'s ordinary approval, ordering, cancellation, and limits. Search/describe themselves count as model tool calls and consume turns. If a long or invalid schema cannot fit, use a smaller batch or correct the host/MCP definition. Schema/description metadata from extensions is exposed to the selected provider when searched/described; configure only trusted extensions and never place credentials in their metadata.

## Plugin SDK (programmatic hosts)

`dragons-agent/plugins` exports `validatePluginManifest`, `readPluginManifest`, `discoverPlugins`, and `PluginRegistry`. Version-1 `plugin.json` manifests contain exactly `apiVersion: 1`, a lowercase safe `id`, a three-part `version`, a printable `name`, and `capabilities: ["tools"]`. Discovery reads bounded metadata under a host-selected root; it rejects symlink directories/files, incompatible versions and malformed entries. It does **not** import, install or activate code.

Trusted host code can call `registry.register(manifest, () => [tool])` and pass `pluginRegistry: registry` to `createDragonsRuntime(...)`. Factories supply fresh tool instances for each foreground run. All registered tool names are prefixed `plugin_<id>_` (hyphens become underscores), with conflicts rejected; all plugin tool calls are classified **EXECUTE** even if a factory declares READ. `runAgent()` performs the normal approval on each call, with cancellation and tool-call limits. Input schemas and returned text are bounded; plugin-supplied mutation metadata is discarded. This is an integration interface for host-trusted implementations, **not** an executable plugin loader or sandbox: a JavaScript factory already running in the host process has host privileges. Never register code merely because a manifest was discovered in a project or downloaded from a catalog. Session resume does not load plugin code; a later run receives only the host's current explicit registrations.

## Lifecycle hooks (programmatic hosts)

Trusted hosts may pass `lifecycleHooks: [{ on: "file_changed", toolName: "plugin_my_plugin_notify" }]` to `createDragonsRuntime(...)`; the binding types and validator are exported from `dragons-agent/lifecycle-hooks`. Events: `session_started` (deferred until the first active user turn; passive creation cannot prompt for approval), `turn_started`, `turn_completed` (per model response), `tool_started` (after the tool's own authorization), `tool_completed` (including denials), and `file_changed` (a successful tool result reports a path inside the workspace). The tool receives its static JSON arguments plus an `event` object (`type`, and when applicable `toolName`, `ok`, or workspace-relative `path`). Reported changed paths are evidence from the tool, **not** a verified filesystem watcher or proof that a change occurred. No event includes provider text, tool arguments or output.

Bindings reference existing host-registered tools, not arbitrary shell strings or downloaded scripts. At most 16 bindings, 4 KiB static arguments per binding and 64 triggered actions per run; actions execute sequentially within `runAgent()` under its normal READ/WRITE/EXECUTE tool authority. WRITE/EXECUTE requests prompt **on each trigger**, even after a session-scoped approval for the same tool. A denial skips that action without granting another; hook actions do not recursively trigger hooks, forge model tool results or enter durable session-search observations. They remain visible as tool activity to the active client. Hooks use host trust and are not a sandbox: an already loaded tool implementation has the host's privileges. CLI/Desktop do not discover hook definitions from workspace files or expose a script loader. Session-end and passive/resumed-session hooks are not available in this programmatic version.

## Reviewed plugin catalog (programmatic hosts)

`dragons-agent/plugin-catalog` exports `ReviewedPluginCatalog`. The shipped offline catalog currently contains the small `hello` example in versions `1.0.0` and `1.1.0`; each manifest's SHA-256 is pinned in the trusted module. No external registry or downloaded code is used.

```ts
import { ReviewedPluginCatalog } from "dragons-agent/plugin-catalog";
import { PluginRegistry } from "dragons-agent/plugins";

const catalog = new ReviewedPluginCatalog(hostOwnedPluginDirectory);
catalog.list();
await catalog.install("hello", "1.0.0");
await catalog.update("hello", "1.1.0");
const registry = new PluginRegistry();
await catalog.activate("hello", registry); // pass registry as pluginRegistry to createDragonsRuntime
await catalog.remove("hello");
```

Install, update and removal affect only validated metadata inside the host-owned directory. Source and installed manifest bytes must match the pinned digest; symlinks, hardlinks, tampering, foreign files, unknown versions and downgrades fail closed. Only compiled, reviewed host code supplies tool factories; activation never imports installed files as code, and registered tool calls still require EXECUTE approval from `runAgent()`. The installation directory must be trusted, single-writer host state; these checks are not a defense against a hostile concurrent writer swapping parent directories. CLI/Desktop do not automatically install or activate catalog entries.

## Skills Hub (programmatic hosts)

`dragons-agent/skill-hub` exports `SkillHub`. Its built-in `bundled` source offers the reviewed `quick-notes` instruction package in versions `1.0.0` and `1.1.0`. A trusted host may register additional **local** source directories with explicit `(source, id, version, sha256)` records. There is no remote download, search across arbitrary registries, executable package format, or automatic source loading from a workspace.

```ts
import { SkillHub } from "dragons-agent/skill-hub";
import { getDragonsSkillsDirectory } from "dragons-agent/skills";

const hub = new SkillHub(getDragonsSkillsDirectory());
hub.listSources();
hub.list("bundled");
await hub.install("bundled", "quick-notes", "1.0.0");
await hub.update("bundled", "quick-notes", "1.1.0");
await hub.remove("quick-notes");
```

The hub validates the pinned digest and skill metadata before installation, rejects symlinks/hardlinks and foreign files, and refuses to overwrite a modified or pre-existing user skill. Upgrading changes the skill digest: existing session references are not silently reactivated, and the user must activate the new version explicitly. Local sources and their pins are supplied by the trusted host and do not persist between processes unless that host persists its own reviewed registry. Use a host-owned, single-writer skill directory; hostile concurrent filesystem swaps are outside this API's guarantees.

`dragons-agent/skill-management` exports `SkillManager` and `createSkillManagementTools(directory)`. A trusted host can pass those five tools to `createDragonsRuntime({ tools: [...] })`; the default runtime does not register them. `skill_validate` is READ and returns the installed or proposed document's SHA-256 digest. `skill_create`, `skill_edit`, `skill_archive`, and `skill_delete` are WRITE and require the existing per-call authorization; edit, archive, and delete also require the current digest. They manage one-file **user** skills under the explicit host-owned directory only, reject extra files and links, and archive to `.archive/<id>/<uuid>/SKILL.md` instead of activating the archived content. Deletion is permanent. These user-directory changes are outside workspace checkpoints/change review; host applications should confirm destructive actions. Project skills can still be managed through ordinary workspace file tools. Validation checks formatting, not the trustworthiness of the instructions.

`dragons-agent/skill-curator` exports `SkillCurator`. Pass a host-owned, single-writer state directory (separate from the skill directory) to its constructor and opt in via `createDragonsRuntime({ skillCurator: curator })`. After a successfully saved run, it records only the scope, ID, SHA-256 digest, count and timestamps for skills actually included in the resolved context. A failed curator write never changes the saved run; inspect `usage()` for its current state. `suggest(await listSkills(...), now)` offers non-mutating maintenance for untracked/changed or 90-day-unused skills, archive review for at most two uses and 180 days of inactivity, and merge review for duplicate bytes in the same scope. Hosts can combine user and project inventories explicitly. No skill is edited, activated or archived by a suggestion. Corrupt state fails closed rather than being silently reset; state is capped at 256 records. Usage metadata is local and not sent to any provider by the curator, though active skill context remains part of the normal model request.

## External Memory provider contract (programmatic hosts)

`dragons-agent/external-memory` exports `ExternalMemoryProvider`, `shareMemoryWithProvider` and `removeMemoryFromProvider`. A trusted host supplies an adapter and an `approve` callback; no adapter, credentials, network access, model tool, CLI/Desktop integration, automatic import, or scheduled/bidirectional sync ships with Dragons. The deterministic, network-free fake lives **only** under `tests/fixtures/` and is not a production provider.

Sharing is a **manual, one-record push**, not a bulk export. The host must present each `approve` request's exact provider ID, action, scope, body and expiry to the user; the callback must be a fresh decision, not a saved setting or model-produced text. Denial performs no remote write. The local record is reread after approval and a changed record fails closed. The requested retention must be 1–365 whole days and is capped by the local memory's expiry; USER and PROJECT scopes are kept separate. Remote removal likewise requires fresh approval for the remote record and never deletes local memory. No incoming records are imported into the local store. The transfer API is not registered as an agent tool by default and never grants WRITE/EXECUTE authority.

This contract does **not** prove a future service actually enforces expiry, deletion, isolation, or non-retention of backups; each adapter needs its own transport/authentication, privacy policy, error handling, and live acceptance. A provider operation can succeed remotely even if the client is cancelled immediately afterward. Host code and adapters run with host privileges and are not sandboxed; the lexical secret check is not comprehensive. A real external service integration is explicitly outside this development scope and remains open.

## Programmatic tool execution

`execute_program` is a READ-dispatched tool available to `runAgent()` in CLI and Desktop, including small and discovered catalogs. Its operation describes the interpreter only; **each nested call receives its own READ/WRITE/EXECUTE authorization**. The model supplies JSON steps, not JavaScript, shell code, a Node `vm` script, imports, or host-object handles. Program variables live only for that invocation in an in-memory map; they are not shared with another turn/session. This is bounded orchestration, **not** an OS security sandbox; an approved shell tool still executes on the host.

Example (the `inventory` tool must be visible to this model turn and return a JSON array of `{id, enabled}` objects):

```json
{"steps":[
  {"op":"call","as":"inventoryResult","tool":"inventory","args":{}},
  {"op":"filter","as":"enabled","from":"inventoryResult.data","field":"enabled","equals":true},
  {"op":"each","as":"observations","from":"enabled","item":"item","steps":[
    {"op":"call","as":"observation","tool":"inspect","args":{"id":{"$ref":"item.id"}}}
  ]},
  {"op":"aggregate","as":"ids","from":"enabled","kind":"collect","field":"id"}
],"return":"ids"}
```

- Every step has a variable name `as` (ASCII letter followed by up to 31 letters/digits/underscores). `call` accepts `tool` and optional JSON `args`; it stores `{ok:true, output:string, data?:parsedJSON}`. Other steps use a dotted `from` variable/property reference: `filter` keeps object entries whose `field` equals `equals` (strict JSON equality); `each` binds `item`, executes its nested steps in input order and stores their final values in an array; `aggregate` accepts `count`, numeric `sum` or `collect` with a field. Use `{"$ref":"variable.property"}` in arguments/equals. `return` is an optional dotted variable/property reference; absent it returns the final step value. Array indexing and arbitrary expressions are intentionally unsupported.
- Limits per invocation: 16 KiB input; 1–16 top-level steps; up to 8 steps per loop body and two nested loop levels; 64 executed steps and 24 nested calls total; at most 20 items in any filtered, aggregated or iterated array; 32 variable names; 16 KiB per stored value/arguments/tool output and 24 KiB final result. Limit/invalid input/tool failure stops further steps with a bounded error. These are limits on **program state**, not a replacement for each tool's existing limits. Avoid large raw outputs when you only need bounded data.
- Calls execute sequentially via the same `runAgent()` tool path as direct calls: ordered tool events, authorization, workspace checks, checkpoint/change evidence, LSP approvals/diagnostics, cancellation and redaction. Nested calls count against `maxToolCalls`; a denied call stops the program and no later step runs. Program recursion is rejected. The program's wrapper result is not duplicated in durable tool observations; nested calls retain their normal safe observations. Program output still enters the selected provider context.
- Hidden catalog tools remain unavailable until `tool_search` discovers them and `tool_describe` activates their schemas. Activation inside a program cannot be used by later steps or calls in the same provider response; use the next model turn. Tool search/describe also consume nested call budget. CLI and Desktop use the same runtime composition; no special per-client executor is installed.

## Inline context references

Use explicit, whitespace-separated references in a new CLI or Desktop message:

```text
Explain @file(src/index.ts) using @folder(src) and @diff
Summarize @url(https://www.wikipedia.org/)
```

`@file(path)` attaches workspace-relative text; spaces inside parentheses are literal. Absolute paths, traversal, sensitive paths/content, symlinks, hard-linked files and special files are rejected. `@folder(path)` attaches sorted direct-entry names/types only, never recursive file contents; sensitive names and links are excluded with a count. `@folder(.)` selects the workspace root. `@diff` attaches tracked HEAD-to-working-tree changes (staged and unstaged, not untracked files); the workspace must be the Git repository root and have HEAD. Git helpers/filters are suppressed using the same read-only Git boundary as review tools.

References require whitespace boundaries. Emails, unknown mentions and backtick inline/fenced code remain literal. Parentheses and control characters in arguments are unsupported. Explicit malformed references fail the submission; errors and limits do not silently drop attachments. Only the fresh user task is resolved, once; model/tool output, attachment contents and restored history are never recursively expanded. Attachments carry visible source labels and are untrusted advisory data, not instructions.

Limits: 8 references, 65,536 input bytes when reference syntax is present, 16,384 bytes per attachment, 49,152 aggregate serialized attachment bytes (also constrained by remaining context budget), 200 direct folder entries or changed Git paths. Oversize inputs fail rather than truncate. Cancel interrupts subsequent resolution and active network/Git work.

`@url` requires a separate one-request EXECUTE approval displaying the full destination. Default EXECUTE denial remains authoritative. Only canonical credential-free HTTPS URLs on the default port are supported: no query, fragment, IP literals, redirects, cookies, authentication, compression, or provider headers. DNS must contain only public IPv4 addresses; IPv6-only and mixed IPv4/IPv6 answers fail closed. The checked address is pinned for connection while TLS validates the original hostname. Requests have a 10-second deadline and accept bounded UTF-8 plain text, Markdown, HTML or JSON only. HTML is attached as text, never executed. Private/local/special-purpose destinations and sensitive response content are rejected. The optional TUI denies URL approvals it cannot fully display; use CLI or Desktop.

These checks are conservative exclusions, not a comprehensive secret detector or a sandbox against hostile concurrent filesystem mutation. Do not reference confidential material. Resolved content enters the selected model request and follows existing provider/session retention; approval does not authorize any action suggested by that content.

## Runtime and Desktop review hardening

Built-in READ Git tools and automatic run change reviews disable external diff/text conversion, fsmonitor, hooks, signature helpers and clean/process filters, and avoid optional index writes. Filtered repositories remain readable, with a notice that comparisons use unfiltered worktree bytes. Review requires the workspace to be the repository root. File writes reject dangling final symlinks. Nested subagent READ tools remain readable; nested delegation still requires its own authorization. Background admission reserves capacity before persistence and releases failed claims.

OpenAI API endpoints, including `OPENAI_BASE_URL`, require HTTPS without embedded credentials, query or fragment; redirects fail rather than forwarding authentication. Only the credential-free Local adapter supports literal-loopback HTTP. ChatGPT serializes credential migration/status reads, login commits, refresh mutations and logout. Logout invalidates pending login/refresh results and waits for started writes before removing credentials. Device-code, polling, token-exchange and refresh requests reject redirects. Its existing restrictive file fallback applies only when native storage is initially unavailable, not after a selected native backend fails writing or verification. API-key slots have no file fallback.

Desktop packages include the dedicated secret-dialog assets. Local slash commands retain the active run identity so cancellation remains available; repeated quit attempts and quit during startup wait for owned runtime cleanup and IPC teardown. Quit does not wait for readiness, workspace dialogs or page navigation; an already-started runtime creation must settle so its result can be disposed. These source safeguards do not establish native platform or live-provider acceptance.

### Conservative provider fallback

Fallback is off by default. A profile can explicitly opt in with `fallback: { "enabled": true, "consent": "allow-context-sharing", "targets": [{ "provider": "openai-api", "model": "gpt-5.4" }] }` in its JSON config. **This consents to sending the current request and assembled project, skills, memory, and plan context to each listed target, including cloud providers when starting from Local.** Choose exact IDs present in the host registry's catalogue/default; unknown IDs, duplicates and more than three targets are rejected. There is no inferred Local-to-cloud route. Omit `fallback` to disable it.

A foreground session or plain one-shot CLI run adopts and displays the target identity before its request. Session adoption is durable; subsequent continuation and resume belong to that target. A plain one-shot run keeps its adopted identity only in process because it does not create a session. Only a fresh first request with a classified retryable pre-stream HTTP failure can switch. Existing continuation, tool results, stream acquisition (including empty/tool-only output), emitted text, and cancellation block switching; the agent loop is never restarted. Diagnostics retain the safe initial identity and the bounded adopted transition history. Child/background factories fail closed because they do not own safe identity adoption.


### Run the latest source checkout

The screenshots show the repository version; an installed npm version may differ. Source development requires **Node.js 22+** and **pnpm 11.17.0**.

```sh
git clone https://github.com/frknaykc/dragons-agent.git
cd dragons-agent
pnpm install --frozen-lockfile
pnpm dragons        # interactive, line-oriented CLI
pnpm dragons --tui  # full-screen TUI
pnpm desktop        # Electron desktop client
```

All three launch commands build first. See the provider setup below before starting a real conversation. Desktop packaging remains a development-distribution milestone, not a signed public installer release.

Configuration `model`/`models` values and registered adapter default models must be exact printable ASCII IDs of 1–256 characters without whitespace. Invalid IDs are rejected rather than silently trimmed; routed IDs such as `vendor/model:variant` are preserved. Validation does not establish model availability or account access.

In the interactive CLI, type `/` for command choices or `/login ` for provider choices. Up/Down moves the selection; Tab or Enter inserts it without executing anything. Press Enter separately to submit the inserted command, or Escape to dismiss the choices. Redirected input remains plain line-oriented input without a picker.

Approved file writes outside rollback coverage show a CLI warning even when the model only reports success. A failed legacy write or patch can leave completed and currently attempted files changed; bounded path warnings describe uncertainty, not automatic recovery. Inspect those files before retrying. No automatic retry or rollback is performed. Checkpoint coverage includes eligible regular-file edits, creation and deletion inside existing directories (256 KiB per image, 2 MiB per batch/history). Missing directories are not created. Structural operations require O_NOFOLLOW; unsupported platforms use approved legacy writes with an explicit no-coverage warning. This is normal workspace conflict detection, not atomic protection against hostile concurrent filesystem writers. Structural partial failures retain only verified completed receipts; uncertain paths require inspection and are never adopted as recovery images.

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

### Checkpoint review (CLI/Desktop)

`/checkpoint list` lists process/session-local snapshots. `/checkpoint diff <id> [--page <n>] [path]` is a local READ command: no provider request or WRITE approval. Small diffs retain the JSON array of exact `before`/`after` strings. Large diffs automatically show page 1; follow the returned JSON `next` command, or select any 1-based page explicitly. Pages visit each selected file's before image then after image in checkpoint order. Each page reports `path`, `side`, UTF-8 byte `offset`/`end`, `byteLength`, and JSON-escaped `text`. Nominal slices are 4,096 bytes (at most 4,099 to preserve complete UTF-8 code points); a 256 KiB before/after pair takes 128 pages. CRLF, controls, emoji and missing final newlines are preserved without partial escape sequences. Unknown flags and out-of-range pages fail locally.

Whitespace/control-bearing paths require exact JSON quoting, for example `/checkpoint diff <id> --page 2 "a  b.txt"`, `/checkpoint diff <id> "tab\t.txt"`, or `/rollback <id> "tail "`. Copy the escaped path selector from the list; unquoted ambiguous whitespace is rejected, never normalized into another filename. Credential-bearing filenames are excluded from capture rather than converted into potentially ambiguous redacted selectors. Rollback still requires WRITE approval and conflict checks; review all pages first.

### Local command availability

Provider/model pickers include a bounded static catalogue of documented model IDs, plus the configured and default model. This is a curated list, not live discovery, account entitlement, or a guarantee of provider access. Local model installations remain unknown; enter their exact model ID yourself. Custom model IDs remain available, but reasoning controls require an exact supported provider/model match. `/provider` shows the selected provider plus safe public metadata: credential method, adapter default, curated-model count, declared adapter capabilities, and whether verified reasoning metadata exists. It never reads or reports credentials, endpoints, factories, pool contents, or account entitlement.

The full-screen TUI supports `/help [filter]`, `/status` (`/session`), `/new` (`/reset`), `/resume <id>`, `/provider [id]`, `/model [name]`, `/context`, `/diagnostics`, `/mcp`, `/tasks`, `/clear`, and `/exit` (`/quit`). Changing provider or model starts a fresh session. In the TUI, `/clear` clears the display only; use `/new` for a fresh conversation. Local TUI instances also expose `/sessions`, `/login`, `/auth`, `/logout`, and `/profile` through trusted host controls. Local CLI, TUI, and desktop sessions support `/reasoning [default|level]`: choices are limited to exact known provider/model capabilities, saved per profile and model, and applied to the next run. `default` removes the override and omits effort from requests. Unknown models have no effort override; no `ultra` alias is invented, and `max` is offered only for explicitly supported models. Remote clients do not expose this local profile control.

Desktop supports `/help [filter]`, `/status` (`/session`), `/new` (`/reset`), and `/resume <id>`. Local desktop instances additionally expose `/sessions`, `/login`, `/auth`, `/logout`, and `/profile [list|create <name>|select <name>]`. Profile selection closes the old runtime and requires restarting the client. Remote connections do not expose local authentication or profile controls. TUI and desktop reject unavailable slash commands locally rather than sending them to the model; their help lists only supported commands. Session resume displays the runtime summary, not an invented transcript.

TUI and local desktop instances support `/login <provider>` for `openai-api`, `anthropic`, `gemini`, and `openrouter`. Named pools use `/login <provider> <slot>` to add a slot, `/login list <provider>` to show only its slot names and safe `ready`, `unverified`, or `cooldown` state, and `/logout <provider> <slot>` to remove it. Select a named slot for new runs with the profile config `apiKeySlots`, for example `{ "gemini": "primary" }`; slot references are not keys. Each profile/provider supports at most 8 named slots, including unverified entries. Slot IDs match `[a-z0-9][a-z0-9_-]{0,31}`. Each new model instance gets its own credential facade and pins its first resolution, including failures; a long-lived registry does not share that cache between runs. A rate-limited selected slot fails closed for new models until its process-local cooldown ends (30 seconds by default, at most five minutes). Named slots use version-1 OS records with verified `ready` state. After restart, explicit selection can recover that record; listing only shows process-local inventory and does not read secrets or discover OS entries. Raw historical or unverified records require removal and re-addition. There is no automatic slot rotation or cross-process inventory coordination. Enter the key only in the dedicated masked prompt, never in chat or a slash command. Desktop uses a separate sandboxed modal with a one-shot host-only credential channel; the chat renderer and remote runtime do not receive the key. Keys are saved and read back for verification in the active profile’s OS credential store, without a plaintext fallback. TUI and desktop close the current runtime after API-key login or logout; restart to continue. The plain CLI leaves the current runtime unchanged and asks you to restart. CLI key entry requires TTY stdin and stdout and uses a dedicated masked raw-input prompt; redirected input cannot supply a key. You can also run `dragons auth login --provider <provider>`, `dragons auth status --provider <provider>`, or `dragons auth logout --provider <provider>`. Local CLI, TUI, and desktop support `/auth [status] [provider]` and `/logout [provider]`; an explicit provider takes precedence over the current session provider, with ChatGPT as the fallback when neither is available. Local models require no login. API-key status checks stored-key presence, not provider access. Logout removes the stored key without changing environment credentials. Provider adapters load profile-stored keys lazily on their first request, with environment-key fallback only for singleton authentication when no stored key exists. Explicit named-slot selection fails closed rather than using an environment key.

Run `dragons` without a task to start an interactive session. Run `dragons --help` for the top-level command families and `/help` inside the CLI for local commands. `/help <filter>` narrows that list. `/login [provider]`, `/auth [provider]`, and `/logout [provider]` are local provider authentication controls; they are never sent to the model. Use `chatgpt` for the experimental ChatGPT Subscription device flow. `/profile`, `/profile create <name>`, and `/profile select <name>` manage isolated profiles. Selecting a profile exits the current client; restart Dragons to load that profile's config, sessions, skills, memory, and credential namespace.

Interactive CLI authentication failures are reported locally without closing the conversation or printing backend exception details. During ChatGPT device sign-in, Ctrl+C cancels the authentication request and returns to the composer; a browser approval alone is not a successful login until credential persistence is verified. Use `/auth chatgpt` to check the stored sign-in state.

The TTY startup centers the DRAGON title, motto and provider/workspace metadata. Only the dragon appears inside the red frame, with a continuous gold-to-red gradient. The input row has matching red separators above and below, with model, context and activity status above it. Tool, MCP and skill listings are not startup panels; their existing commands remain available. Redirected/non-TTY output stays plain and omits the banner. The full dragon needs a sufficiently wide terminal; narrower startup artwork is clipped to fit rather than scaled.

<p align="center">
  <img src="assets/dragons-cli-composer.png" alt="CLI input detail: model and idle status above an input row bounded by two red horizontal separators." width="960">
</p>

To reproduce the documentation preview without loading credentials or contacting a provider, run `pnpm build && node scripts/preview-cli.mjs` in a native terminal of at least 100 columns × 44 rows. This is a presentation-only fixture, not an interactive agent or live-provider acceptance test. Press Enter to exit. Terminal font and ANSI palette settings affect the appearance.

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
/login
/auth
/logout
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
pnpm build:tests
node --test .test-build/tui/tui-controller.test.js .test-build/tui/tui-screen.test.js .test-build/tui/tui-terminal.test.js
python3 scripts/verify-tui-pty.py  # POSIX PTY fixture; not a native-emulator visual test
```

## Desktop foundation

The desktop client uses a small Electron shell with plain local HTML/CSS/JavaScript, rather than a UI framework or a second agent engine. Electron and its packaging tools are **development-only** dependencies; the CLI package's installation requirements are unchanged. M77 provides native development packages for macOS arm64, Windows x64 and Linux x64, not a published or publicly trusted release.

```sh
pnpm install --frozen-lockfile
pnpm desktop
# To choose a different trusted workspace after building:
# cd /path/to/workspace
# /path/to/DragonsAgent/node_modules/.bin/electron /path/to/DragonsAgent/desktop/main.mjs
pnpm acceptance:desktop  # actual local window; deterministic provider, no live inference
```

Source-checkout launch uses the working directory as the immutable workspace. A packaged local launch instead asks for a workspace through a native main-process folder picker; cancellation exits without creating a runtime, and invalid selections are rejected. Remote launches retain the host's workspace and do not show this picker. Use local `/login <provider>` for the host-owned credential prompt, or configure credentials on the host; do not enter keys in chat. Remote windows cannot manage host credentials. Choose **Host default** to use configured provider/model/limits, or select an explicit provider/model; create a session or resume its ID, send a request, observe streamed text and tool activity, allow once/deny the exact pending operation, or cancel. Resume restores saved continuation, not prior message display. Provider/model changes apply to new sessions only.

The sandboxed renderer has no Node integration. Its isolated preload exposes only validated runtime commands and a bounded event drain. Only the exact local main frame may invoke them; there is no filesystem, shell, credential, or arbitrary Electron RPC. The main process owns the M71 runtime and existing workspace/authorization boundary. All content uses text nodes; scripts, navigation, popups, webviews, permissions and external network/content are blocked in the renderer. The event queue is capped at 256 events / 512 Ki characters and disconnects/cancels on overflow; the UI retains at most 80 messages of 32,000 characters and 16,000 activity characters. Closing/crashing the window cancels and disposes its runtime. Memory suggestions are explicitly rejected; plan/background editing and automatic MCP connection are outside this foundation.

Deterministic bridge tests run on all CI platforms without a GUI. `acceptance:desktop` separately exercises the actual Electron window, sandbox/preload, configured model defaults, inert model content, streaming, real isolated write allow/deny, cancellation, resume and reload cleanup. Reload is a fail-closed disconnect: the window closes and cancels its run; reopen and resume explicitly. Neither test path establishes live provider acceptance.

### Trusted Desktop host isolation (source checkout)

Trusted main-process composition can call `createDesktopRuntime(workspace, { configPath, profileName })` from `dist/desktop/host.js` after building. This is a source-checkout host API, not a renderer/IPC option, CLI flag, or package export. The normal one-argument launch is unchanged: it uses the platform config root and persisted active profile.

```js
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopRuntime, desktopLocalControls } from "./dist/desktop/host.js";

const root = await mkdtemp(join(tmpdir(), "dragons-desktop-acceptance-"));
const options = {
  configPath: join(root, "config.json"),
  profileName: `acceptance-${randomUUID()}`,
};
const runtime = await createDesktopRuntime(workspace, options);
// Keep root/options for restart persistence; dispose before recomposing:
await desktopLocalControls(runtime).close();
await runtime.dispose();
```

`configPath` is an absolute **base config path**, passed to the existing profile store; the named profile uses `<root>/profiles/<profileName>/config.json`, with its own sessions, memory and skills directories. An injected path fails closed without an explicit valid non-default profile name. The override pins this composition and does not rewrite `profiles/active.json`; reuse the same options after restart. `/profile select` can still persist selection in this root, but it does not supersede a host-pinned name on restart.

**Credential boundary:** filesystem-root isolation is not Keychain isolation. Native credentials still use the shared OS service `Dragons Agent`: ChatGPT uses `chatgpt-subscription:<profileName>` (the default account is `chatgpt-subscription`), API keys use `api-key:<profileName>:<provider>`, and named slots use `api-key-slot:<profileName>:<provider>:<slot>`. Paths are not part of those account labels. The caller must generate a unique acceptance profile name, must not reuse a real profile name, and must not treat this option as an OS credential sandbox. Legacy ChatGPT `auth.json` is scoped to the selected config directory; inherited environment credentials are unchanged. Local reasoning/session operations need no credential reads or network; authentication/model operations can still access native storage or network. Deterministic host tests guard native credential methods and fetch, and never run those operations. This configuration alone does not authorize live authentication, model calls, or GUI acceptance.

### Development application packages (M77)

`pnpm desktop:pack` builds an unpacked application for the host platform; `pnpm desktop:dist` builds local DMG/ZIP (macOS), NSIS (Windows), or AppImage/DEB (Linux) targets. Outputs go to ignored `desktop-artifacts/`. Build natively on each platform: a successful macOS build does not verify Windows/Linux or another CPU architecture. The Electron entry point is overridden only in the application package; npm continues to expose the CLI/runtime.

These are unsigned/ad-hoc development artifacts, not notarized or publicly trusted installers. No auto-update, publishing, version bump, tag, or release is included. See [M77 scope, acceptance evidence and limitations](m77-application-distribution.md) before treating a package as distributable.

Desktop now displays update status with check/cancel controls. Production checks remain disabled without a host-owned trusted source and policy; the renderer cannot configure either. The check verifies signed metadata only. Optional trusted launcher injection into `openDesktop` can also enable parameterless `update_prepare` IPC: the host controller downloads verified bytes into private temporary staging, validates the macOS bundle, and runs pinned Developer ID signature and conservative target preflight. It owns single-flight, deadline, cancellation, stale-result suppression and cleanup on failure/close. `prepared` is not installable (`canInstall: false`); no activation, helper, launch or real-data migration is authorized. The renderer has no prepare button yet and cannot supply trust keys, URLs, identities or paths. macOS staging supports bounded ZIP32 decoding, native XML/binary plist parsing and validated internal framework symlinks, preserving executable permissions without special mode bits. ZIP64, fat Mach-O and non-ASCII archive paths remain unsupported; staging is not native activation or OS signing acceptance.

M78 adds internal [signed-manifest verification, private staging and AppImage worker primitives](m78-secure-auto-update.md), not an enabled auto-updater. Trust comes from pinned Ed25519 public keys; SHA-256 only verifies the artifact bound by the signed manifest. Production trust roots and update sources are not configured. The AppImage worker is not connected to the desktop lifecycle; macOS/Windows activation, OS-enforced real-data barriers and M79 migration compatibility remain unimplemented and unaccepted.

## Live provider acceptance

From a source checkout, `pnpm acceptance:provider --live --provider chatgpt` runs a bounded READ-only acceptance through the public runtime and real registered adapter. Other provider IDs are `openai-api`, `anthropic`, `gemini`, `openrouter`, and `local`; each uses its existing credential/configuration path. It uses an isolated temporary fixture, checks native streaming, tool-result continuation, multi-turn/session isolation and cancellation, and removes temporary state. It does not install local runtimes or authorize effectful tools.

The [M76 evidence and configuration matrix](m76-live-provider-acceptance.md) separates actual live verification from missing credentials/runtimes and deterministic coverage. Live checks are explicit opt-in, not part of ordinary credential-free CI. An incomplete attempt requires evidence-based classification, not an automatic product-defect or upstream-failure label.

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
pnpm build:tests
node --test .test-build/runtime/shared*.test.js .test-build/runtime/session-execution-lease.test.js .test-build/runtime/runtime-admission-cap.test.js
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

Use `dragons mcp list`, `dragons mcp connect <id>`, `dragons mcp connect-all`, `dragons mcp status`, and `dragons mcp disconnect <id>` after adding valid non-secret server configuration to Dragons' local config. `/mcp connect-all` provides the same process-local interactive behavior. Dragons accepts up to eight configured MCP servers, connects at most two at once, namespaces every exposed tool by server ID, and caps the combined active MCP tool set at 128. A failed server remains isolated; connected servers and their authorization requirements stay active. For a disposable, opt-in published-server/ChatGPT probe that does not change your profile, see [external MCP acceptance](live-mcp-acceptance.md).

## Memory

Memory is explicit, local, and user- or project-scoped. Dragons does not automatically learn or silently write Memory, and it does not use a vector database or RAG system. For a task, it deterministically selects at most eight matching USER/current-project records (at most 8,000 body characters) with case-insensitive lexical matching; unrelated and other-project records are excluded, and the resulting context remains advisory-only. A model may create a bounded pending suggestion, but it is shown verbatim and remains process-local until the user explicitly accepts it with `/memory accept <suggestion-id>`; `/memory reject <suggestion-id>` or process exit leaves nothing stored. `dragons memory suggest [user|project] <body>` is non-interactive and displays an unpersisted candidate only. Suggestions reject credential-shaped values, code blocks, and oversized content. Manage saved records with `dragons memory list`, `dragons memory add`, `dragons memory show`, and `dragons memory delete`.

## Planning, subagents, and background tasks

Plans are bounded, explicit session-local tasks. Subagents are one-level only and receive a restricted read-only tool snapshot; they cannot recursively create teams. `/tasks` remains read-only and process-local: its state and continuation do not survive process exit. `/jobs start <task>` creates a separate read-only persistent job; `/jobs`, `/jobs show <id>`, `/jobs cancel <id>`, `/jobs resume <id>`, and `/jobs cleanup` provide bounded management. Jobs enforce a bounded active count, duration, turns, output, and durable storage. Only bounded lifecycle metadata and redacted result summaries are durable; runtime handles, approvals, credentials, and tool registries are never stored. After a process exit, active persistent jobs reconcile once to `interrupted` and require explicit manual resume—Dragons never blindly retries them.

Duration exhaustion also terminalizes a job when it occurs during initial durable admission, without invoking a model after cancellation. Local embeddings can await `PersistentBackgroundJobManager.wait(id)` while a job is active to include outstanding cancellation polling and execution-claim release; a terminal status alone is not a filesystem-cleanup barrier. Polling remains single-flight.

On Windows, atomic job-file replacement retries transient rename `EPERM` failures up to six attempts with at most 310 ms of scheduled backoff. Between attempts the temporary file is cleaned and the store lock released so cancellation can proceed; every new attempt reacquires the lock and rechecks the original expected revision. The destination is never deleted as a fallback, permissions are not relaxed, and persistent failures remain errors.

## Coding intelligence

v0.1.0 includes bounded repository intelligence, JavaScript/TypeScript symbol navigation, approval-gated unified-diff `apply_patch`, heuristic test recommendations, and Git/current-run self-review.

### Opt-in LSP diagnostics

Without an `lsp` entry in the active profile's `config.json`, behavior is unchanged: no language server discovery, download, installation or startup. To use a server you have separately installed and trust, explicitly configure its absolute executable and arguments. For example, adapt these placeholder absolute paths to your installation (this is not an install command):

```json
{
  "lsp": {
    "command": "/absolute/path/to/node",
    "args": ["/absolute/path/to/language-server/cli.mjs", "--stdio"],
    "languageId": "typescript",
    "extensions": [".ts"],
    "timeoutMilliseconds": 3000
  }
}
```

Only these five keys are accepted. `args`, `languageId` and `extensions` are required; timeout defaults to 3000ms and is restricted to 100–10000ms. One server/language mapping is supported. Arguments must not contain credentials. There is no shell, PATH executable lookup, environment/config discovery or inherited provider credential environment; servers requiring environment setup or `/usr/bin/env node` may be unavailable. Use an absolute interpreter and script instead. Restart the host after changing configuration.

After a successful built-in `write_file`, `edit_file` or `apply_patch`, each matching changed document (maximum four per tool call) requests **EXECUTE `lsp_diagnostics_start`** through `runAgent()`. WRITE approval never authorizes startup. Every inspection uses a new process and a new EXECUTE approval; even "allow session" applies only to that inspection. CLI (including the actual TTY prompt) and Desktop show the full quoted command, ordered argument array and document path. A dedicated allowlisted approval DTO, not raw tool arguments, crosses the runtime/Desktop bridge. Its serialized scope is limited to 4096 UTF-8 bytes (command/each argument 2048 characters, document 512, at most 16 arguments); recognized credentials, controls/format characters, extra fields or oversized scopes fail closed before approval/startup rather than hiding execution identity behind redaction or truncation. The optional full-screen TUI cannot show this scope and denies LSP startup with a CLI/Desktop notice; its other approvals are unchanged. Denial leaves the successful write intact and reports diagnostics skipped. There is no model-callable server-start tool, and shell/MCP effects, rollback, delegated children and persistent background jobs do not trigger this feature.

The client performs actual Content-Length framed JSON-RPC: initialize/initialized, didOpen and LSP document diagnostics. It uses a full `textDocument/diagnostic` response when supported; otherwise it accepts only `publishDiagnostics` for the exact opened file URI and version 1. Unversioned push diagnostics are ignored, not presented as clean. Each process sees a single bounded post-write document snapshot, with no shared document cache between writes/sessions. Results are advisory server output, not proof a project builds or is error-free. No workspace diagnostics, edits, commands, configuration requests, registration, file watchers or server-initiated reads are serviced.

Redacted, bounded line/column/severity/messages reach the next model turn and plain/interactive CLI output; Desktop uses its existing bounded tool-activity output. Missing server, timeout, stale/unversioned messages, cancellation and protocol/resource failures are distinct from a successful empty report. The client excludes recognized sensitive paths, symlinks, hardlinks and oversized/non-UTF-8 documents. Per process: 128KiB document, 256KiB frame, 8KiB headers (frame parsing is independent of stdout chunk boundaries), 2MiB cumulative stdout/stderr, 256 messages, 20 displayed diagnostics, 512 characters per message and 8192 characters per document; aggregate reporting is limited to 16384 characters and the runtime's smaller event-byte cap still applies. Shutdown has a 200ms cleanup deadline followed by forced termination.

**Trust boundary:** an approved language server is arbitrary local code, not an OS-sandboxed READ tool. It may read workspace/project configuration, load plugins, write files or access the network independently of the client. Only approve a server and workspace you trust. Credentials are not intentionally passed, but lexical redaction is not a complete secret detector. Parent-directory races/out-of-band edits are not an atomic hostile-writer guarantee. POSIX same-group descendants are killed at cleanup; detached descendants and Windows descendant trees are not guaranteed contained. Scoped real-server acceptance covers macOS arm64 with Microsoft `@typescript/native-preview@7.0.0-dev.20260707.2`; this does not establish general server or installed-platform compatibility. See [acceptance evidence](lsp-diagnostics-acceptance.md).

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

This is not a legal privacy policy. See [SECURITY.md](../SECURITY.md) for vulnerability reporting and boundary notes.

## Platform status

- **macOS:** selected CLI/Desktop development flows have native user-acceptance evidence; this is not blanket acceptance of the latest auth changes or signed installers. See [development acceptance](cli-desktop-user-acceptance.md) and [M78 release gates](m78-secure-auto-update.md).
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
