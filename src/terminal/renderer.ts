import type { ToolOperation } from "../tools.js";
import { DRAGONS_BANNER } from "./banner.js";

export type ActivityState = "idle" | "thinking" | "reading" | "searching" | "editing" | "running" | "approval" | "cancelled" | "error";

export type TerminalRendererOptions = {
  write: (text: string) => void;
  isTTY: boolean;
  color: boolean;
  width: number;
  now?: () => number;
};

export type StatusLineOptions = {
  model: string;
  context?: string;
  state: ActivityState;
  frame: number;
  sessionElapsedMs: number;
  runElapsedMs?: number;
  width?: number;
};

export type ToolPresentation = {
  name: string;
  operation: ToolOperation;
  arguments: string;
};

export type ApprovalPresentation = ToolPresentation;

type StartupMetadata = {
  provider: string;
  model: string;
  workingDirectory: string;
};

const ACTIVE_BAR_WIDTH = 10;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  orange: "\x1b[33m",
  brightYellow: "\x1b[93m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

const FIRE_PALETTE = [ANSI.red, ANSI.orange, ANSI.brightYellow];

function truncate(text: string, width: number): string {
  const characters = Array.from(text);
  if (characters.length <= width) return text;
  if (width <= 1) return "…";
  return `${characters.slice(0, width - 1).join("")}…`;
}

function style(text: string, sequence: string, color: boolean): string {
  return color ? `${sequence}${text}${ANSI.reset}` : text;
}

/** Uses only broadly supported ANSI foreground colours when truecolor is unavailable. */
function fireGradient(text: string, color: boolean): string {
  return text.split("\n").map((line, index) => style(line, FIRE_PALETTE[index % FIRE_PALETTE.length]!, color)).join("\n");
}

function activityBar(state: ActivityState, frame: number): string {
  if (state === "idle") return "░".repeat(ACTIVE_BAR_WIDTH);
  const filled = Math.min(ACTIVE_BAR_WIDTH, 1 + ((frame % 5) * 2));
  return `${"▓".repeat(filled)}${"░".repeat(ACTIVE_BAR_WIDTH - filled)}`;
}

function conciseArgument(arguments_: string): string {
  try {
    const parsed = JSON.parse(arguments_) as Record<string, unknown>;
    if (typeof parsed.patch === "string") {
      const files = [...parsed.patch.matchAll(/^\+\+\+ (?:[ab]\/)?([^\n\t ]+)/gm)].map((match) => match[1]).filter(Boolean).slice(0, 4);
      return files.length ? `patch: ${files.join(", ")}${parsed.patch.length > 2_000 ? " (large)" : ""}` : "patch";
    }
    const value = parsed.command ?? parsed.path ?? parsed.pattern ?? parsed.query ?? parsed.name;
    if (typeof value !== "string" || !value) return "";
    return parsed.pattern === value || parsed.query === value ? JSON.stringify(value) : value;
  } catch {
    return "";
  }
}

export function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatSeparator(width: number): string {
  return "─".repeat(Math.max(1, Math.floor(width)));
}

export function formatStatusLine(options: StatusLineOptions): string {
  const context = options.context ?? "--";
  const runElapsed = options.runElapsedMs ?? 0;
  const spinner = options.state === "idle" ? "" : `${SPINNER_FRAMES[options.frame % SPINNER_FRAMES.length]} `;
  const line = `⚕ ${options.model} │ ctx ${context} │ [${activityBar(options.state, options.frame)}] ${spinner}${options.state} │ ${formatElapsedTime(options.sessionElapsedMs)} │ ⏲ ${formatElapsedTime(runElapsed)}`;
  return options.width === undefined ? line : truncate(line, Math.max(1, options.width));
}

export function formatToolEvent(presentation: ToolPresentation): string {
  const marker = presentation.operation === "READ" ? "◇" : presentation.operation === "WRITE" ? "◆" : "▶";
  const argument = conciseArgument(presentation.arguments);
  return `${marker} ${presentation.name}${argument ? `  ${argument}` : ""}`;
}

export function formatToolCompletion(name: string, ok: boolean): string {
  return `${ok ? "✓" : "✗"} ${name}`;
}

export function formatApproval(presentation: ApprovalPresentation, width: number): string {
  const usableWidth = Math.max(28, Math.floor(width));
  const title = " Permission required ";
  const top = `╭─${title}${"─".repeat(Math.max(1, usableWidth - title.length - 3))}╮`;
  const summary = conciseArgument(presentation.arguments);
  const lines = [top, `│ ${presentation.operation} · ${presentation.name}`];
  if (summary) lines.push(`│ ${summary}`);
  lines.push(`╰${"─".repeat(Math.max(1, usableWidth - 2))}╯`, "Allow once? [y]  Allow matching scope for session? [session]  Deny? [N] ");
  return lines.join("\n");
}

export class TerminalRenderer {
  private readonly startedAt: number;
  private readonly now: () => number;
  private frame = 0;
  private state: ActivityState = "idle";
  private runStartedAt: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private transientVisible = false;
  private metadata: StartupMetadata | undefined;

  constructor(private readonly options: TerminalRendererOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  renderStartup(metadata: StartupMetadata): void {
    this.metadata = metadata;
    if (!this.options.isTTY) return;
    this.options.write(`${fireGradient(DRAGONS_BANNER, this.options.color)}\n${style(`${metadata.provider} · ${metadata.model}`, ANSI.dim, this.options.color)}\n${style(metadata.workingDirectory, ANSI.dim, this.options.color)}\n\n`);
  }

  renderComposer(): void {
    if (!this.options.isTTY) {
      this.options.write("> ");
      return;
    }
    const line = this.statusLine();
    const separator = style(formatSeparator(this.options.width), ANSI.dim, this.options.color);
    const identity = style("𓆩 DRAGON 𓆪", ANSI.orange, this.options.color);
    const hint = style("Ask anything, or type / for commands…", ANSI.dim, this.options.color);
    const cursor = style("›", ANSI.brightYellow, this.options.color);
    this.options.write(`${line}\n${separator}\n  ${identity} ${hint} ${cursor} `);
  }

  startRun(state: ActivityState = "thinking"): void {
    this.stopTransient();
    this.state = state;
    this.runStartedAt = this.now();
    if (!this.options.isTTY) return;
    this.renderTransient();
    this.timer = setInterval(() => {
      this.frame += 1;
      this.renderTransient();
    }, 120);
    this.timer.unref();
  }

  setActivity(state: ActivityState): void {
    this.stopTransient();
    this.state = state;
    if (this.options.isTTY && this.runStartedAt !== undefined && state !== "approval") {
      this.renderTransient();
      this.timer = setInterval(() => {
        this.frame += 1;
        this.renderTransient();
      }, 120);
      this.timer.unref();
    }
  }

  renderMessage(text: string): void {
    this.stopTransient();
    this.options.write(text);
  }

  renderToolStarted(presentation: ToolPresentation): void {
    this.stopTransient();
    if (!this.options.isTTY) {
      this.options.write(`\n• ${presentation.name}\n`);
      return;
    }
    const output = style(formatToolEvent(presentation), presentation.operation === "READ" ? ANSI.cyan : ANSI.yellow, this.options.color);
    this.options.write(`\n${output}\n`);
    const state = presentation.operation === "READ"
      ? (presentation.name === "grep" || presentation.name === "search_files" ? "searching" : "reading")
      : presentation.operation === "WRITE" ? "editing" : "running";
    this.setActivity(state);
  }

  renderToolCompleted(name: string, ok: boolean): void {
    this.stopTransient();
    if (!this.options.isTTY) {
      this.options.write(`\n${formatToolCompletion(name, ok)}\n`);
      return;
    }
    const output = style(formatToolCompletion(name, ok), ok ? ANSI.green : ANSI.red, this.options.color);
    this.options.write(`\n${output}\n`);
    if (ok) this.setActivity("thinking");
  }

  renderApproval(presentation: ApprovalPresentation): void {
    this.stopTransient();
    this.state = "approval";
    if (!this.options.isTTY) {
      this.options.write(`\n? Allow ${presentation.operation} ${presentation.name} with ${presentation.arguments}? [y/N] `);
      return;
    }
    this.options.write(`\n${style(formatApproval(presentation, this.options.width), ANSI.yellow, this.options.color)}`);
  }

  renderCancelled(): void {
    this.stopTransient();
    this.state = "cancelled";
    this.options.write(this.options.isTTY ? "\n⊘ cancelled\n" : "\nCancelled.\n");
  }

  renderError(message: string): void {
    this.stopTransient();
    this.state = "error";
    const output = this.options.isTTY ? `✗ ${message}` : `Error: ${message}`;
    this.options.write(`\n${style(output, ANSI.red, this.options.color)}\n`);
  }

  finishRun(): void {
    this.stopTransient();
    this.state = "idle";
    this.runStartedAt = undefined;
  }

  dispose(): void {
    this.stopTransient();
  }

  private statusLine(): string {
    return style(formatStatusLine({
      model: this.metadata?.model ?? "--",
      state: this.state,
      frame: this.frame,
      sessionElapsedMs: this.now() - this.startedAt,
      runElapsedMs: this.runStartedAt === undefined ? undefined : this.now() - this.runStartedAt,
      width: this.options.width,
    }), ANSI.dim, this.options.color);
  }

  private renderTransient(): void {
    if (!this.options.isTTY || this.runStartedAt === undefined) return;
    this.options.write(`\r\x1b[2K${this.statusLine()}`);
    this.transientVisible = true;
  }

  private stopTransient(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.transientVisible && this.options.isTTY) this.options.write("\r\x1b[2K");
    this.transientVisible = false;
  }
}

export function createTerminalRenderer(options: TerminalRendererOptions): TerminalRenderer {
  return new TerminalRenderer(options);
}
