# Worktree management acceptance (2.4)

Scope: explicit CLI and local Desktop commands create or select isolated registered sibling Git worktrees. No model tool or automatic workspace selection. The CLI starts a fresh session and rebinds workspace-scoped tools/checkpoints only between turns. Desktop remains fixed until reopened in the selected directory. Remote runtime and TUI remain unchanged.

Verification on fixture Git repositories: `pnpm build:tests && node --test .test-build/core/worktree.test.js .test-build/desktop/worktree-bridge.test.js` — 6 passed, 0 failed. Covers dirty source preservation, registration/name/path validation, symlink rejection, source and worktree-specific `includeIf` filter suppression and Desktop host-only slash behavior. Post-repair `pnpm release:check` — `RELEASE_CHECK_OK`; 1,245 passed, 2 skipped, 0 failed (1,247 tests), typecheck/build/package verification passed.

Limitations: no live provider, cross-process switch race or Windows filesystem acceptance; a failed Git materialization can leave partial state, intentionally not deleted automatically. A same-user adversary can race path topology. Desktop requires reopen rather than hot runtime replacement. Initial independent review BLOCKED the target-specific filter path; post-repair independent re-review PASS, including a separate `includeIf.onbranch` fixture with no smudge execution.
