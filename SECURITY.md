# Security Policy

## Shared-session boundary

The shared host is a coordinator above the existing core, not a second executor. It reserves a single foreground owner per session before asynchronous admission, requires revision refresh after another writer, and routes approval/cancellation only to the owning connection. Observer streams omit actionable approval IDs, are independently bounded, and cannot cancel an owner's work when detached. Client IDs do not authenticate callers; trusted host composition and remote principal session access remain required. The optional multi-connection remote mode never relaxes bearer, Origin, Host, sequence or session-ownership checks.

Default file-backed runtimes and persisted interactive CLI runs take an independent exclusive execution lease before loading current continuation, retaining it through execution and persistence. A stale lock is a fail-closed condition, not permission to steal ownership. Injected custom stores without `acquireExecution` do not establish cross-process coordination. Shared revisions cover foreground writes admitted by the shared host, not arbitrary out-of-band edits; the underlying core must not be shared with independent writers.

## Reporting a vulnerability

A private security reporting channel has not yet been established for this repository. Do **not** include API keys, access or refresh tokens, authorization headers, credentials, private project data, or exploit payloads containing sensitive data in a public issue.

Until private reporting is configured, open a minimal public issue that states a security concern exists without disclosing sensitive details. Repository maintainers can later enable GitHub private vulnerability reporting as a repository setting; it is not enabled or assumed by this document.

## Relevant security boundaries

- **Workspace containment:** built-in file tools validate workspace-relative paths and reject escapes, including unsafe symlink targets.
- **Authorization:** WRITE and EXECUTE operations fail closed and require explicit Dragons approval. Built-in READ tools are non-mutating by design.
- **Credentials:** Dragons uses native credential storage where supported, with a restrictive local fallback for its own authentication state. Never commit credentials or include them in Memory records.
- **MCP:** configured stdio MCP servers are external local processes. Enable and trust them deliberately; Dragons remains the authorization boundary for their exposed tools.
- **Experimental ChatGPT transport:** the ChatGPT Subscription path is implementation-specific and experimental. Compatibility and security assumptions should be reviewed carefully.
- **Desktop foundation:** local HTML and all model/tool content are untrusted. The renderer is sandboxed with context isolation and no Node integration; exact-main-frame IPC is a validated runtime-command allowlist. Workspace and credentials are host-side only. External navigation/content and renderer permissions are denied. Close/crash/event overflow cancels owned work; approvals are one-use and exact-session/run/request bound. Electron is a development-only shell, not an installed or auto-updated desktop distribution.
- **Remote foundation:** the HTTP/SSE server is loopback-only, with host-supplied random bearer credentials per principal, exact Host/Origin policy, bounded input/transport resources, monotonic command sequences and principal-owned session allowlists. Every runtime operation remains behind the validated bridge and `runAgent()` authority. Tokens never authorize direct filesystem/shell RPC. Disconnect cancels owned runs and invalidates pending approvals; reconnect does not replay effects. A separately secured tunnel is required for remote access; no public listener or TLS gateway is shipped. Explicit CORS preflight reveals only fixed protocol metadata, never runtime state.

This policy describes the current project boundaries; it does not guarantee that every third-party provider, MCP server, shell command, or project dependency is safe.
