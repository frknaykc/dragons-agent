# Dragons Agent

<p align="center">
  <img src="docs/assets/banner.png" alt="Dragons Agent project banner" width="960">
</p>

[![npm version](https://img.shields.io/npm/v/dragons-agent?logo=npm&label=npm)](https://www.npmjs.com/package/dragons-agent)
[![npm downloads](https://img.shields.io/npm/dm/dragons-agent?logo=npm&label=downloads)](https://www.npmjs.com/package/dragons-agent)
[![CI](https://github.com/frknaykc/dragons-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/frknaykc/dragons-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/frknaykc/dragons-agent)](LICENSE)

An AI coding agent for your terminal, with a desktop client. Read and edit code, run commands, and continue work across sessions with explicit approval for file changes and execution.

**Status:** early public release, v0.1.0. CLI and Desktop are the current priorities; an optional full-screen TUI is also available. Desktop packages remain development builds, not signed public installers.

<p align="center">
  <img src="docs/assets/dragons-cli.png" alt="Dragons Agent interactive CLI" width="960">
</p>

## Install

Requires **Node.js 22+**.

```sh
npm install -g dragons-agent
dragons
```

## Quick start

### ChatGPT subscription (experimental)

```sh
dragons auth login --provider chatgpt
dragons --provider chatgpt
```

Sign in through the browser/device flow. This integration is experimental and is not an officially supported OpenAI third-party subscription client.

### API providers

```sh
dragons auth login --provider openai-api
dragons --provider openai-api
```

Enter your API key in the masked local prompt, never in chat. API-key login requires native credential storage. Provider API usage is billed separately.

| Provider | Provider ID | Environment alternative |
| --- | --- | --- |
| OpenAI | `openai-api` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |

Choose a model and save your defaults:

```sh
dragons config set-provider openai-api
dragons config set-model openai-api <model-id>
```

Available models depend on your provider account. Use `--model <model-id>` to override the default for a run.

### Local models

Connect to an already-running OpenAI-compatible server, such as Ollama or vLLM:

```sh
dragons config set-local-endpoint http://127.0.0.1:11434/v1
dragons config set-model local qwen2.5-coder:7b
dragons --provider local
```

Install the model separately and choose one with tool-calling support. Plain HTTP is limited to literal loopback addresses; the Local adapter does not send API credentials.

## Everyday use

Run `dragons` for an interactive session, or pass a task directly:

```sh
dragons "Explain how this project is structured"
```

Type `/` to browse commands. Use **Up/Down** to choose, **Tab** or **Enter** to insert, then **Enter** to submit. Press **Ctrl+C** to cancel an active run.

| Command | Purpose |
| --- | --- |
| `/help` | Show commands available in the current client |
| `/status` | Show the current session and model |
| `/sessions` | List saved sessions |
| `/resume <id>` | Continue a saved session |
| `/new` | Start a fresh conversation |
| `/login <provider>` | Sign in or save an API key locally |
| `/profile` | Manage isolated profiles |
| `/reasoning` | View supported reasoning settings |
| `/checkpoint list` | List available local snapshots |
| `/checkpoint diff <id>` | Review a snapshot before rollback |
| `/diagnostics` | Inspect recent-run diagnostics |

Command availability differs between CLI, Desktop, TUI, and remote connections. Check `/help` in your client. Profile selection and credential changes may require restarting the client.

## Features

- Streamed coding conversations with workspace file search, editing, patching, and shell tools.
- Saved sessions, isolated profiles, provider/model selection, and reasoning controls for supported models.
- Checkpoint review and approval-gated rollback for covered changes. Checkpoints are local to the process/session and do not replace Git or backups.
- Explicit local Skills and Memory, session plans, read-only subagents, and background jobs.
- Opt-in MCP integrations and post-edit LSP diagnostics.

LSP diagnostics require a separately installed, explicitly configured language server and a separate execution approval. Server compatibility varies; the optional full-screen TUI cannot approve LSP startup. See [LSP setup and limits](docs/advanced-usage.md#opt-in-lsp-diagnostics).

Provider fallback is off by default. Enabling it explicitly allows the assembled request and project context to reach the configured fallback providers, including cloud providers when starting from Local.

## Desktop and source checkout

Requires **Node.js 22+** and **pnpm 11.17.0**.

```sh
git clone https://github.com/frknaykc/dragons-agent.git
cd dragons-agent
pnpm install --frozen-lockfile
pnpm dragons        # interactive CLI
pnpm desktop        # Electron desktop client
pnpm dragons --tui  # optional full-screen terminal client
```

Each launch command builds first. The screenshots show the source version; the published npm version may differ. Desktop supports conversations, provider/model selection, session resume, approvals, and cancellation. Resume restores conversation continuation, not the prior message display.

## Permissions and privacy

- **READ** tools inspect workspace or runtime information without prompting by default.
- **WRITE** tools require approval before changing files.
- **EXECUTE** tools require approval before running commands or external capabilities.

Your selected provider may receive project context, tool inputs, and tool results. Approved commands, MCP servers, and language servers can affect your machine; they are not an OS sandbox. Review execution requests and trust the programs you configure.

A failed write can leave partial changes, and some operations fall outside checkpoint coverage. Inspect warnings and affected files before retrying. Never put credentials in prompts, source files, or Memory.

See [SECURITY.md](SECURITY.md) for security boundaries and vulnerability reporting.

## Documentation

- [Advanced usage and configuration](docs/advanced-usage.md): profiles, credentials, MCP, LSP, Desktop, and runtime integrations.
- [Contributing](CONTRIBUTING.md): development setup, repository layout, and tests.
- [Roadmap](ROADMAP.md): planned work and release status.

## License

MIT © 2026 Furkan "NaxoziwuS" Aykaç. See [LICENSE](LICENSE).
