# Phase 2 — scoped development acceptance

Status: **2.1–2.6 accepted in scoped development** (2026-09-23). Separate targeted live ChatGPT acceptance passed four cases; see [live provider probes](phase2-live-provider-acceptance.md). A separately published stdio MCP server also passed a bounded [live ChatGPT-through-MCP probe](live-mcp-acceptance.md), synthetic [macOS and Windows native GUI WRITE approval flows](desktop-visual-approval-acceptance.md) passed, and the [Windows source test inventory](windows-test-acceptance.md) passed file by file. None of these records establishes production-release, full Windows/Linux platform acceptance, remote HTTP MCP or broad native-GUI acceptance. The six ROADMAP entries preserve the individual evidence and limitations; their gate counts are historical snapshots, not six runs on the final tree.

| Item | Acceptance record | Independent review | Final item gate |
| --- | --- | --- | --- |
| 2.1 LSP Diagnostics | [LSP](lsp-diagnostics-acceptance.md) | PASS | 1201 passed / 2 skipped |
| 2.2 Inline Context References | [Inline context](inline-context-acceptance.md) | PASS after repair | 1223 passed / 2 skipped |
| 2.3 Session Search | [Session search](session-search-acceptance.md) | PASS after repair | 1239 passed / 2 skipped |
| 2.4 Worktree Management | [Worktrees](worktree-acceptance.md) | PASS after repair | 1245 passed / 2 skipped |
| 2.5 Dynamic Tool Search | [Tool search](tool-search-acceptance.md) | PASS after repair | 1254 passed / 2 skipped |
| 2.6 Programmatic Tool Execution | [Programmatic execution](programmatic-tool-execution-acceptance.md) | PASS | 1264 passed / 2 skipped |

The earlier 2.6 `pnpm release:check` result was the combined deterministic gate for its then-current source tree: **1264 passed, 2 skipped, 0 failed**. After the live-provider harness was added and corrected, the gate passed on that harness snapshot: **1271 passed, 2 skipped, 0 failed**. The latest macOS `pnpm release:check` after the Windows portability changes passed **1272 passed, 3 skipped, 0 failed**, with typecheck, build and package verification successful. The four live case outcomes are separate, user-reported CLI evidence in the linked record.

## Boundary and remaining work

- Beyond the earlier deterministic development proof (except the separately recorded macOS arm64 native TypeScript-preview LSP acceptance for 2.1), four targeted live ChatGPT probes, one published stdio MCP + ChatGPT probe, and one human-clicked synthetic Desktop WRITE deny/allow flow on each of macOS and Windows passed. The Windows source archive passed `pnpm typecheck` and 67 focused Phase 2 tests on an earlier snapshot. On the updated source, `pnpm build:tests` and the full **176-file**, 90-second-per-file test inventory passed: **1123 passed, 152 skipped, 0 failed, 0 timed out**; [scope and skipped cases](windows-test-acceptance.md). The earlier interrupted single-command `pnpm test` run remains failed, and Windows checkpoint capture/rollback remains unsupported; these results do not establish remote HTTP MCP, network URL flow, full Windows/Linux filesystem behavior, packaged Windows Desktop, additional native dialogs or PTY acceptance. Worktree isolation is not an OS sandbox; its documented cross-process path races and failed checkout partial state remain limitations.
- The LSP TLS 5.0.0 unversioned push case and stable/default server policy are not accepted; see the 2.1 record. Publication, signed/native distribution and M78 release gates remain open in ROADMAP.
- Work remains uncommitted on local `main`; acceptance is scoped development evidence, not a commit, CI run, push or production release. No commit or push is authorized by this record.
