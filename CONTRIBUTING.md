# Contributing to Dragons Agent

Thanks for improving Dragons Agent. This is an early-stage project; focused, well-tested changes are more useful than broad rewrites.

## Development setup

Requirements:

- Node.js 22 or newer
- pnpm (the repository declares the supported pnpm version)

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Run a focused compiled test after building when working in one area:

```sh
pnpm build:tests
node --test .test-build/<subsystem>/<focused-test>.test.js
```

Run `pnpm release:check` before proposing package or release-facing changes.

## Source, tests and generated output

- `src/` contains application TypeScript only; `desktop/` contains the Electron shell assets.
- `tests/<subsystem>/` contains permanent Node regressions. Use `tests/integration/` for cross-subsystem milestone tests, `tests/fixtures/` for subprocess servers/PTY fixtures and `tests/acceptance/` for explicit acceptance harnesses plus their deterministic regressions.
- `experiments/macos-native/` preserves the disposable M78 C labs and their shell gates. They are not shipping app code or production updater acceptance.
- `scripts/` retains build, packaging, verification and development entrypoints; script regression tests live in `tests/desktop/`.

`pnpm build` always cleans `dist/` before compiling application JavaScript/declarations. This removes stale tests from old checkouts; do not delete individual generated files by hand. `pnpm build:tests` builds the app, cleans `.test-build/`, then compiles only `tests/**/*.ts` without declarations. Both output directories are ignored. `pnpm clean` removes only `dist/`; `node scripts/clean-build.mjs tests` removes only `.test-build/`.

Tests use explicit relative `.js` imports into `dist/`: TypeScript checks the generated declarations and Node exercises the same application build that ships. Imports within test/acceptance/fixture code remain relative `.js` imports. The parallel `tests/` and `.test-build/` layouts preserve those paths. Use `new URL(..., import.meta.url)` for repository assets and child-process modules; preserve deliberately injected subprocess cwd values.

`pnpm test` recursively discovers all compiled `*.test.js` and source `tests/**/*.test.mjs`; it never auto-runs fixture servers or live acceptance entrypoints. The Windows NSIS PowerShell regression remains an explicit native CI step. `pnpm typecheck` builds declarations and checks both production and test TypeScript. Live provider commands remain explicit opt-ins; this layout does not grant permission to run them.

Historical acceptance documents may show the old `src/*.test.ts` / `dist/*.test.js` locations. Those commands describe the recorded snapshot, not current focused-test commands.

## Code and test expectations

- Follow the existing TypeScript ESM style: explicit imports, two-space indentation, semicolons, and Node's built-in test runner.
- Keep changes small and preserve established workspace containment, ordered execution, cancellation, context bounds, and authorization behavior.
- Add focused regression or acceptance coverage for behavioral changes, then run the relevant full checks.
- Do not place credentials, tokens, real provider responses, or sensitive project data in source, fixtures, logs, or documentation.
- Normal tests must be deterministic and must not make live provider calls. Live acceptance commands are explicit opt-in paths.
- Update user-facing documentation when behavior, configuration, safety boundaries, or CLI commands change.

## Pull requests

Describe the problem, the chosen solution, and how you verified it. Keep each pull request focused, include tests for behavioral changes, and call out any effect on READ/WRITE/EXECUTE authorization, workspace boundaries, providers, MCP, or persistent local state.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a detailed public issue.
