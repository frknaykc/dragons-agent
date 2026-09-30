# Phase 2.6 — Programmatic Tool Execution: scoped acceptance

Status: scoped development acceptance complete after independent read-only **PASS** (2026-09-23). A later targeted [live ChatGPT probe](phase2-live-provider-acceptance.md) passed with a supplied valid program; native-platform acceptance is not claimed.

## Scope and security boundary

- `src/programmatic-tool.ts` interprets bounded declarative JSON; no JavaScript evaluation, Node `vm`, OS sandbox claim, host handles, persistent program variables, new provider adapter or second privileged tool loop.
- `src/agent.ts` registers the tool for each run and routes each nested call through the existing `executeToolCall` authorization, event, checkpoint/change, LSP and cancellation path. Model-order execution and call IDs remain distinct. Nested call counts contribute to the existing run budget; recursion is rejected.
- Per-response visibility snapshot applies to nested calls. Search/describe may activate a hidden tool, but execution must wait for the next model turn. Program wrapper tool history is not persisted twice and does not capture nested approval decisions; individual nested tools retain their existing safe observation policy.
- CLI one-shot and Desktop use the same `runAgent()` composition. Scoped ROADMAP acceptance does not imply commit, push, live provider sign-off or publication.

## Verification

- Focused deterministic test: `pnpm build:tests && node --test .test-build/runtime/programmatic-tool-input.test.js .test-build/integration/m30-integration.test.js` — **12 passed, 0 failed**. Covers denied READ/WRITE/EXECUTE, default effect denial, approved built-in WRITE mutation evidence/checkpoint, ordered filter/each/aggregation, discovery/activation visibility, cancellation, bounds and error path, and CLI/Desktop composition. The existing M30 parent-tool assertion now includes `execute_program`; child/background tool sets remain unchanged.
- Final release gate after that test correction: `pnpm release:check` — **1264 passed, 2 skipped, 0 failed/cancelled**; typecheck, build and package verification passed (`RELEASE_CHECK_OK`). Independent read-only review **PASS**; program and integration tests **12/12**, history/redaction tests **12/12**. These are deterministic code-scope findings, not live approval or platform acceptance.

## Review limits

An approved nested tool retains its real authority and may affect the host; the interpreter isolates *program state*, not the operating system. Dynamic MCP/provider behavior and real Desktop GUI/native approval dialogs need separate independent acceptance. Complex program data larger than the explicit budgets fails rather than running unbounded.
