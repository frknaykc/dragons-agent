# Security Policy

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

This policy describes the current project boundaries; it does not guarantee that every third-party provider, MCP server, shell command, or project dependency is safe.
