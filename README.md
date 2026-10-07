# Dragons Agent

<p align="center">
  <img src="docs/assets/banner.png" alt="Dragons Agent project banner" width="960">
</p>

[![npm version](https://img.shields.io/npm/v/dragons-agent?logo=npm&label=npm)](https://www.npmjs.com/package/dragons-agent)
[![CI](https://github.com/frknaykc/dragons-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/frknaykc/dragons-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/frknaykc/dragons-agent)](LICENSE)

Dragons Agent is a coding agent for the terminal, with an Electron desktop client. It can inspect a workspace, edit files, run commands, and resume saved conversations. File changes and command execution require explicit approval.

**Status:** early public release (`v0.1.0`). CLI and Desktop are the main clients; the full-screen TUI is optional. Desktop packages are development builds, not signed public installers.

<p align="center">
  <img src="docs/assets/dragons-cli.png" alt="Dragons Agent interactive CLI" width="960">
</p>

## Install

Requires Node.js 22 or newer.

```sh
npm install -g dragons-agent
dragons
```

Run `dragons "Explain this repository"` for a single task, or run `dragons` to start an interactive session in your current workspace.

## Choose a provider

API keys are entered through a masked local prompt and stored in native credential storage. Provider API usage is billed separately.

```sh
dragons auth login --provider openai-api
dragons --provider openai-api
```

Other API providers are `anthropic`, `gemini`, and `openrouter`. To save a provider and model as defaults:

```sh
dragons config set-provider openai-api
dragons config set-model openai-api <model-id>
```

You can also connect an already-running OpenAI-compatible local server:

```sh
dragons config set-local-endpoint http://127.0.0.1:11434/v1
dragons config set-model local qwen2.5-coder:7b
dragons --provider local
```

Install the model separately and choose one that supports tool calls. Plain HTTP is limited to literal loopback addresses; the Local adapter sends no API credentials.

ChatGPT subscription sign-in is experimental and is not an officially supported OpenAI third-party client:

```sh
dragons auth login --provider chatgpt
dragons --provider chatgpt
```

See [provider configuration](docs/advanced-usage.md#providers) for other credential options and model settings.

## Use Dragons Agent

Type `/` in the interactive CLI to browse commands; `/help` shows commands supported by your client. Use `/sessions` and `/resume <id>` to continue work, `/profile` to manage isolated profiles, and `/checkpoint list` to review local snapshots. Press **Ctrl+C** to cancel an active run.

Attach context with `@file(src/index.ts)`, `@folder(src)`, or `@diff`. URL context (`@url(https://example.com/)`) requires separate network approval.

The CLI and Desktop also support optional MCP integrations, skills, background tasks, workspace Kanban, and read-only scheduled work. Start with [advanced usage](docs/advanced-usage.md) for configuration and limitations.

## Desktop and source checkout

Requires Node.js 22+ and pnpm 11.17.0:

```sh
git clone https://github.com/frknaykc/dragons-agent.git
cd dragons-agent
pnpm install --frozen-lockfile
pnpm dragons        # interactive CLI
pnpm desktop        # Electron desktop client
pnpm dragons --tui  # optional full-screen client
```

These commands build the current checkout before launching. Desktop packages are not published as signed installers. See [Contributing](CONTRIBUTING.md) for test and build commands.

## Permissions and privacy

Built-in **READ** tools inspect workspace or runtime information without prompting by default. **WRITE** changes and **EXECUTE** commands require approval. Your selected provider may receive prompts, relevant project files, and tool results. Approved commands and configured integrations are not an OS sandbox. Review approvals, and keep credentials out of prompts and source files.

Read [SECURITY.md](SECURITY.md) for the security model and vulnerability reporting.

## More information

- [Advanced usage and configuration](docs/advanced-usage.md)
- [Contributing](CONTRIBUTING.md)
- [Roadmap](ROADMAP.md)

## License

MIT © 2026 Furkan "NaxoziwuS" Aykaç. See [LICENSE](LICENSE).