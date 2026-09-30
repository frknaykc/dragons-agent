# External MCP + ChatGPT acceptance (opt-in)

**Live result (user-reported CLI output, 2026-09-23):** `pnpm acceptance:mcp-chatgpt -- --live` printed `External MCP + ChatGPT acceptance passed (synthetic fixture cleaned).` The harness requires one exact-path EXECUTE approval and one external MCP read, checks the returned synthetic marker in the server result and provider response, then closes the server and removes the fixture. This is a scoped stdio/provider pass, not interactive approval, HTTP MCP, cross-platform or release acceptance.

The separately published `@modelcontextprotocol/server-filesystem@2026.8.31` was exercised locally on macOS with a disposable directory, through Dragons' MCP discovery, `runAgent()` authorization and one read. The server advertised 14 tools; the scoped read succeeded, the directory was removed and no filesystem-server process remained. This **deterministic external-server check** did not invoke ChatGPT.

For the separate **live provider-through-MCP** check, from the repository root:

```sh
pnpm acceptance:mcp-chatgpt -- --live
```

Prerequisites: Node 22+, pnpm, `npx` with access to the npm registry, and Dragons ChatGPT already signed in. The command builds the tests, then starts the pinned published server over stdio, restricted to a newly created temporary directory. It exposes only `read_text_file` to the provider, rejects any other tool or path, grants one `EXECUTE` authorization for the exact synthetic file, and independently verifies the server result, single invocation, and provider-returned random marker. It closes the server and removes the fixture even on failure. It does **not** modify the Dragons profile or repository configuration. The fixture's authorization is automatic and does not test an interactive GUI approval.

The probe allows at most four model turns; provider retries may cause more than four network requests, so this is **not** a billing ceiling. This is a real provider call and may consume quota. Do not repeat a failure blindly or share credentials, raw responses, or full traces. A nonzero exit means no pass; the published server/registry may be unavailable independently of provider behavior. The regular test suite never launches the published server or makes a paid model call. Windows/Linux, remote HTTP MCP, GUI approvals and production distribution remain separate tracks.
