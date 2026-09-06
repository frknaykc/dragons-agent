# M76 — Live provider acceptance

Baseline: Phase 17 `3bc574f`. Package version remains `0.1.0`.

## Architecture and configuration inspected

- `src/provider/registry.ts` and `builtins.ts`: per-run descriptor factories, capabilities and model defaults.
- `src/config.ts`: validated user configuration and per-provider `models` overrides. Selection uses the provider override, the active provider's configured model, then its registered default.
- `openai.ts`: OpenAI SDK Responses transport; `OPENAI_API_KEY`.
- `codex.ts`, `codex-auth.ts`, `credential-store.ts`: ChatGPT Subscription Responses transport, Dragons-owned authentication (`dragons auth login --provider chatgpt`), native keyring with established protected-file fallback. No other application's credential store is imported.
- `anthropic.ts`: Messages SSE; `ANTHROPIC_API_KEY`.
- `gemini.ts`: Gemini streaming API; `GEMINI_API_KEY`.
- `openrouter.ts`: OpenRouter streaming Chat Completions; `OPENROUTER_API_KEY`. Tool support depends on the selected model; registry capabilities do not establish every upstream model's capabilities.
- `local.ts` and the shared endpoint validation in `openrouter.ts`: credential-free OpenAI-compatible transport; plain HTTP requires literal loopback, remote endpoints require HTTPS. No authenticated HTTP path is introduced. Configuration uses `localEndpoint`; default `http://127.0.0.1:11434/v1`. Registered default model is `qwen2.5-coder:7b`.
- `retry.ts`, provider compatibility errors, adapter stream parsers, continuation validation, runtime redaction, session isolation and `runAgent()` authorization remain authoritative. The harness does not introduce another execution loop or retry policy.
- Existing `provider-acceptance.ts` / `acceptance:openai` / `acceptance:chatgpt` run a broader WRITE/EXECUTE coding scenario. `smoke:live` is text-only. Neither is substituted for the new READ-only multi-provider contract.
- Existing adapter, M66, provider/runtime redaction, cancellation, continuation and isolation tests are included by `pnpm test`. `release:check` runs test, typecheck, build and package verification; ordinary CI remains deterministic on Ubuntu/macOS/Windows, with no live credentials added.

## Reproducible opt-in contract

From a source checkout, with only the provider's established credential/configuration available:

```sh
pnpm acceptance:provider --live --provider chatgpt
# Other exact IDs: openai-api, anthropic, gemini, openrouter, local
```

The command uses `createDragonsRuntime` → the registered real adapter → live service → `runAgent()` READ authorization → `read_file` → tool-result continuation. An observing descriptor wrapper records counts and booleans; it does not replace the adapter transport. No raw HTTP inference bypasses Dragons.

A temporary workspace contains a random harmless sentinel in `fixture.txt`. The model first returns `DRAGONS_READY`, then reads the fixture and returns its contents in the same session. A separate session is cancelled at the first native adapter text delta. Session inputs are checked for absent inherited continuation/tool outputs. Only `read_file` is exposed as an injected tool; effectful approvals are denied. Memory suggestions are rejected. No source repository, private user files, shell execution or network tools are needed.

Bounds: 3 turns per runtime run, 8 adapter calls overall, 24,000 context characters, 1,024-byte tool output, 60-second inference cancellation budget, 90-second process watchdog. Existing bounded adapter retry semantics are preserved and retries counted. A forced process kill cannot promise cleanup; leftover harness-owned directories must be audited and removed before accepting evidence.

The CLI prints only booleans, counters, controlled classifications and a validated model identifier. Runtime events/results/errors/status and temporary persisted files are checked in memory against the actual credential values obtained through established mechanisms. No tokens, raw model responses or request dumps are retained as evidence. Normal cleanup removes temporary sessions/workspace. This audit establishes no observed leak on exercised surfaces, not a mathematical guarantee against every possible secret encoding; deterministic redaction coverage remains required.

Injected-descriptor tests exercise the harness deterministically and never constitute live evidence. Incomplete live attempts return `REQUIRES_CLASSIFICATION`: a human must distinguish credential/runtime/environment blockers, model capability limitations, upstream failures and product defects from evidence. Missing tool support is not automatically labelled a Dragons defect. Usage metadata is observational, not invented when absent.

## Observed live matrix — 2026-09-06

| Provider | Status | Text | Tool call | Continuation | Prerequisite / evidence |
|---|---|---|---|---|---|
| OpenAI API | BLOCKED_BY_CREDENTIAL | NOT_TESTED | NOT_TESTED | NOT_TESTED | `OPENAI_API_KEY` absent |
| ChatGPT Subscription | LIVE_VERIFIED | PASS | PASS | PASS | Dragons-owned session; registered default `gpt-5.6-terra` |
| Anthropic | BLOCKED_BY_CREDENTIAL | NOT_TESTED | NOT_TESTED | NOT_TESTED | `ANTHROPIC_API_KEY` absent |
| Gemini | BLOCKED_BY_CREDENTIAL | NOT_TESTED | NOT_TESTED | NOT_TESTED | `GEMINI_API_KEY` absent |
| OpenRouter | BLOCKED_BY_CREDENTIAL | NOT_TESTED | NOT_TESTED | NOT_TESTED | `OPENROUTER_API_KEY` absent; no model tested |
| Local Model Provider | BLOCKED_BY_RUNTIME | NOT_TESTED | NOT_TESTED | NOT_TESTED | No configured override; default literal-loopback port 11434 refused connection; no runtime/model installed or downloaded |

ChatGPT post-fix evidence: text, native streaming, READ tool completion, continuation, multi-turn input, fresh-session isolation, cancellation, credential audit and cleanup all true; 4 adapter calls, 0 retries. Usage metadata was not exposed. No forced upstream failures, quota exhaustion or model capability failures were induced; those paths remain deterministically tested only. Other providers' deterministic passes must not be read as live acceptance.

## Demonstrated product defect and regression

One defect class discovered live: cancelling ChatGPT after a streamed delta could terminate Node with an unhandled `AbortError`. The native fetch body was already errored when the abort listener invoked `reader.cancel()`; its rejected promise was unobserved.

`src/provider/stream-cancellation.test.ts` reproduces this using synthetic errored streams, with **5/5 failures before the fix and 5/5 passes after**: ChatGPT, Anthropic, Gemini, OpenRouter, and Local (which shares the OpenRouter-compatible parser). Four adapter cancellation listeners now observe the cancellation promise rejection; the original aborted read still rejects, cancellation is preserved and no retry occurs after output. OpenAI uses the SDK parser rather than these listeners. The affected ChatGPT live acceptance was rerun successfully after the repair. The sibling repairs have deterministic evidence only.

No authentication/TLS policy, core runtime authorization, package version, publication, distribution or M77 changes are part of this milestone. Final deterministic gates, independent review and remote CI evidence are recorded with the M76 completion report; this document alone does not assert those gates have run.
