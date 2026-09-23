# Dragons Agent

Dragons Agent is a TypeScript/Node terminal-native coding-agent runtime. The CLI is a presentation/composition layer; the runtime owns ordered tool execution, workspace containment, cancellation, sessions, and READ/WRITE/EXECUTE authorization. Provider adapters supply model protocol and continuation handling only.

## Start here

Use the nearest relevant source/test pair and existing context. Consult `package.json` for commands/dependencies, `README.md` for user-facing behavior, `CONTRIBUTING.md` for contribution rules, and `SECURITY.md` when a safety boundary changes; these are not a mandatory per-edit reading checklist. Reread only changed or missing context. Use `IDEA.md` for product intent; current behavior is defined by source and tests.

- `src/cli.ts`, `src/cli/`: executable CLI, command parsing, interactive flow, config composition.
- `src/agent.ts`: provider-neutral loop and authoritative tool-authorization boundary.
- `src/tools.ts`, `src/apply-patch.ts`: workspace-bounded tools and patching.
- `src/provider/`: protocol adapters; `registry.ts` is the extension boundary and `builtins.ts` registers providers.
- `src/config.ts`, `src/session-store.ts`: local config and persisted continuation/session validation.
- `src/mcp-client.ts`, `src/skills.ts`, `src/memory.ts`, `src/plan.ts`: explicit local extensions/advisory state.
- `src/terminal/`: TTY rendering; preserve plain non-TTY behavior.
- `desktop/`, `src/desktop/`: Electron presentation and trusted host/IPC lifecycle.
- `src/read-only-git.ts`: shared non-mutating Git boundary for tools and automatic change review.
- `tests/<subsystem>/`: permanent regressions; `tests/fixtures/`: test helpers; `tests/acceptance/`: acceptance harnesses.
- `experiments/macos-native/`: native research labs, not production helpers.
- `scripts/verify-package.mjs`, `scripts/release-check.mjs`: package and release verification.
- `.github/workflows/ci.yml`: cross-platform CI source of truth.

Use nested `AGENTS.md` only when a large subsystem gains rules that would make this root file noisy.

## Environment and commands

Node.js 22+ and pnpm 11.17.0 are required. CI installs with `pnpm install --frozen-lockfile`.

```sh
pnpm install
pnpm test                 # builds, then runs compiled Node tests
pnpm typecheck            # builds app, then checks app and test TypeScript
pnpm build                # clean app build -> dist/ (.js and .d.ts)
pnpm build:tests          # build app, then compile tests -> .test-build/
pnpm dragons              # build and run the CLI
pnpm acceptance:mcp
pnpm verify:package
pnpm release:check
pnpm release:pack
```

For a focused test, build first: `pnpm build:tests && node --test .test-build/<subsystem>/<focused-test>.test.js`. There is no separate lint script; `pnpm typecheck` is the static-check gate. CI runs test, typecheck, and build on Ubuntu, macOS, and Windows.

For package/runtime milestone acceptance, run `pnpm release:check` once after the final material change, plus `pnpm audit --prod` when dependency audit is required. `release:check` already runs test, typecheck, build, and package verification: do not prepend or repeat those commands for the same unchanged snapshot. During implementation use affected tests. Run any separately promised MCP, PTY, or live acceptance only when applicable; deterministic tests do not establish live provider acceptance. Preserve valid evidence through read-only reviews. A review timeout is incomplete review, not grounds to rerun unchanged tests. This acceptance command does not authorize publication, version changes, tagging, or release.

## Conventions

- Track planned work in `ROADMAP.md`; mark items complete only with scoped acceptance evidence. Preserve existing milestone gates.
- CLI and Desktop are the current product priorities. Do not embed or select a mandatory full-screen TUI framework. Keep UI-independent runtime/host contracts suitable for a future user-owned or replaceable TUI adapter. Preserve existing TUI code and regression compatibility; new TUI feature parity is deferred, not a release requirement unless explicitly requested.

- Strict TypeScript ESM/NodeNext: use explicit relative `.js` import specifiers.
- Match existing two-space indentation and semicolons.
- Tests use `node:test` and `node:assert/strict`; keep deterministic fakes/injected transports rather than live provider calls. Add regressions under `tests/`, not `src/`; compiled tests import the production `dist/` modules. The test runner discovers compiled `.test.js` and source `.test.mjs` recursively. See `CONTRIBUTING.md` for fixture/import conventions.
- Keep provider wire formats in `src/provider/<provider>.ts`; add metadata/factories via `registry.ts` and `builtins.ts`, not `agent.ts`.
- Provider factories and continuation state must remain per-run/session isolated, bounded, validated, and credential-free.
- Update `README.md` for user-visible CLI, configuration, provider, or safety-boundary changes.

## Critical boundaries and traps

- `runAgent()` is the sole tool authority: READ is non-mutating; WRITE and EXECUTE fail closed without approval. Providers must never execute tools directly.
- Preserve workspace containment, model-order tool execution, cancellation propagation, output/error/context bounds, and provider/session isolation.
- Never put credentials, tokens, authorization headers, real provider responses, or private project data in source, fixtures, logs, docs, config, sessions, or Memory.
- Only the credential-free Local adapter may use plain HTTP, and only with literal loopback endpoints; do not create an authenticated HTTP provider path.
- Route READ Git operations through `src/read-only-git.ts`; preserve helper/filter suppression and optional-index-write protection. These comparisons use unfiltered worktree bytes.
- API-key pools allow at most 8 named slots per profile/provider. Keep listing credential-free, verified restart recovery explicit, cooldown process-local, and credential caches per model/run rather than per registry.
- Serialize OAuth migration/status reads that can write, login commits, refresh mutations, and logout. Reject OAuth redirects and stale or cancelled login commits.
- Publish Desktop cleanup ownership before awaiting navigation; repeated quit and partial startup must preserve disposal and IPC teardown.
- Do not hand-edit `dist/`, `.test-build/`, `node_modules/`, `.env*`, package tarballs, or local `.hermes/` state. `dist/` contains generated application JavaScript and API declarations; tests compile separately to ignored `.test-build/` without declarations. Neither tests nor experiments belong in distribution packages.
