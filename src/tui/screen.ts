import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import type { TuiState } from "./controller.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const MAX_DRAFT = 8_000;
export type ViewState = {
  draft: string;
  cursor: number;
  scroll: number;
  panel: "conversation" | "activity";
  allowSelected: boolean;
};

/** The terminal adapter alone owns escape sequences. Even status and user text are untrusted. */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "�")
    .replace(/\t/g, "  ");
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

export function clipLine(text: string, width: number): string {
  let output = "";
  let used = 0;
  for (const part of graphemes(terminalText(text).replace(/\n/g, " "))) {
    const size = stringWidth(part);
    if (used + size > width) break;
    output += part;
    used += size;
  }
  return output;
}

export function wrapText(text: string, width: number): string[] {
  if (width < 1) return [""];
  const lines: string[] = [];
  for (const paragraph of terminalText(text).split("\n")) {
    let line = "";
    let used = 0;
    for (const part of graphemes(paragraph)) {
      const size = stringWidth(part);
      if (used + size > width) { lines.push(line); line = ""; used = 0; }
      if (size > width) continue;
      line += part;
      used += size;
    }
    lines.push(line);
  }
  return lines;
}

export function screenSize(columns: number, rows: number): { width: number; height: number } {
  // Keep the final physical column unused: no autowrap or bottom-right scrolling.
  return {
    width: Math.max(0, Math.min(239, Math.floor(Number.isFinite(columns) ? columns : 80) - 1)),
    height: Math.max(1, Math.min(120, Math.floor(Number.isFinite(rows) ? rows : 24))),
  };
}

export function renderScreen(state: TuiState, view: ViewState, columns: number, rows: number): string[] {
  const { width, height } = screenSize(columns, rows);
  const session = state.session;
  const lines = [
    "DRAGONS / TUI v2",
    `${session?.provider ?? "--"} / ${session?.model ?? "--"} | ${state.busy ? "RUNNING" : "READY"}`,
    `Session: ${session?.id ?? "starting"}`,
    `Context: ${state.status?.contextCharacters ?? 0}/${state.status?.contextBudgetChars ?? "--"} | Plan tasks: ${session?.planTaskCount ?? 0} | Background: ${state.background.length}`,
  ];
  const bottom = state.approval ? [
    `PERMISSION: ${state.approval.operation} ${state.approval.toolName}`,
    `Request: ${state.approval.approvalId}`,
    `${view.allowSelected ? " Deny    [ALLOW ONCE]" : "[DENY]    Allow once"} | Tab: select, Enter: confirm`,
    "Esc / Ctrl+C: cancel run | Ctrl+D: exit",
  ] : [
    `${state.error ? `Error: ${state.error}` : `${view.panel} | Tab: switch view | PgUp/PgDn: scroll | Ctrl+R: refresh`}`,
    `> ${draftWindow(view, Math.max(0, width - 2))}`,
    "Enter: send | Esc/Ctrl+C: cancel | Ctrl+D: exit",
  ];
  if (height < 9 || width < 24) {
    // No invisible approval choice can be selected in this mode (adapter enforces it).
    return [clipLine("Resize terminal (min 25x9)", width), ...Array(Math.max(0, height - 1)).fill("")];
  }
  const available = height - lines.length - bottom.length - 1;
  const content = view.panel === "conversation"
    ? state.messages.flatMap((message) => wrapText(`${message.role === "assistant" ? "Dragon" : message.role === "user" ? "You" : "Info"}: ${message.text}`, width))
    : [...state.activity, ...state.background.map((task) => `Background ${task.id} [${task.state}]${task.report ? `: ${task.report}` : ""}`)].flatMap((text) => wrapText(text, width));
  const offset = Math.min(Math.max(0, view.scroll), Math.max(0, content.length - available));
  const end = Math.max(0, content.length - offset);
  const visible = content.slice(Math.max(0, end - available), end);
  lines.push(`--- ${view.panel}${offset ? ` (${offset} lines above latest)` : ""} ---`);
  lines.push(...visible, ...Array(Math.max(0, available - visible.length)).fill(""), ...bottom);
  return lines.slice(0, height).map((line) => clipLine(line, width));
}

function draftWindow(view: ViewState, width: number): string {
  const parts = graphemes(terminalText(view.draft));
  const before = parts.slice(0, view.cursor);
  // A visible block is used instead of trusting the terminal cursor's glyph width.
  let prefix = before.join("");
  while (stringWidth(prefix) + 1 > width && before.length) { before.shift(); prefix = before.join(""); }
  return clipLine(`${prefix}▏${parts.slice(view.cursor).join("")}`, width);
}
