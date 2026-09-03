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
pnpm build
node --test dist/<focused-test>.test.js
```

Run `pnpm release:check` before proposing package or release-facing changes.

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
