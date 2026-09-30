# Phase 2 ChatGPT live probes (four scoped cases accepted)

User-reported CLI results on September 23, 2026: `inline`, `session`, `catalog` and the final `program` run each reported **passed (synthetic fixture cleaned)**. Earlier `program` runs failed three times; the last failure classified an **unknown step operation**, but the exact model-supplied step was not retained. The fixture prompt was then changed from prose to complete valid `call` → `filter` → `aggregate` JSON, and the harness now independently checks the submitted program structure. Offline regression **7/7** and `pnpm release:check` **1271 passed / 2 skipped / 0 failed** (typecheck/build/package passed) covered that final harness snapshot before the last live `program` run. That live pass tests execution of a supplied program, not unaided model composition of program syntax.

These are **four independent, read-only provider probes**, not a single acceptance of every Phase 2 feature. The existing `pnpm acceptance:chatgpt -- --live` already exercised a separate approved edit-and-test fixture. The new cases run the real ChatGPT provider through the CLI's `runAgent()` path, with one disposable synthetic workspace per invocation and no access to the user's repository files, session store or credential contents. Authentication is read through Dragons' own secure store. A maximum of eight model turns is allowed per case; this is **not** a hard HTTP-request or billing cap because a provider adapter may retry a turn. No live case is run by normal tests or `release:check`.

First run the offline regression: `pnpm build:tests && node --test .test-build/acceptance/phase2-chatgpt.test.js`. When the user explicitly opts into a case, run one command at a time from the repository root:

```sh
pnpm acceptance:phase2-chatgpt -- --live inline
pnpm acceptance:phase2-chatgpt -- --live session
pnpm acceptance:phase2-chatgpt -- --live catalog
pnpm acceptance:phase2-chatgpt -- --live program
```

- `inline`: a temporary Git commit/diff and `@file` contain two independently generated markers. The model must return both without a tool call. No user Git tree is touched.
- `session`: a synthetic saved session contains a marker; both `session_search` and `session_read` must complete, then the marker must be returned.
- `catalog`: 27 injected READ tools force hidden-catalog discovery. The model must perform `tool_search` → `tool_describe` → `fixture_lantern_probe` in order and return that tool's marker; the fixture counts executions.
- `program`: `execute_program` is given a complete valid JSON program and calls a READ-only fixture tool, then filters/aggregates its JSON result. The exact submitted program input, wrapper and nested tool completions, single fixture execution and returned marker are checked. This does **not** prove the model can compose program syntax unaided.

The script checks tool starts/completions, catalog order, exact fixture execution count, marker return and absence of any unexpected tool or WRITE/EXECUTE approval request. Each synthetic fixture is removed in `finally`, including failures. A nonzero exit is **not acceptance**; do not blindly repeat live calls. No token, device code, authorization header or raw provider response should be saved or shared. The CLI prints only a pass marker or generic failure classification. Testing program state on a real provider is not OS sandboxing or an authorization grant.

These four probes alone do **not** establish external MCP, real Desktop approval dialogs, Windows/Linux filesystem behavior, worktree management, URL fetching, LSP server operation, or production distribution acceptance. A separate [published stdio MCP + ChatGPT probe](live-mcp-acceptance.md) and one synthetic [macOS Desktop WRITE approval flow](desktop-visual-approval-acceptance.md) later passed; they do not change the other boundaries. Each remaining area needs its own scoped evidence. A model that fails to choose the requested sequence fails that case; fix the probe deterministically before considering a further live request. Record the outcome and limits per case after running it, not in advance.
