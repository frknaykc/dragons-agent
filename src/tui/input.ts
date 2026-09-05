import { MAX_DRAFT, terminalText } from "./screen.js";

export type InputAction =
  | { type: "insert"; text: string }
  | { type: "enter" | "backspace" | "delete" | "left" | "right" | "home" | "end" | "tab" | "pageup" | "pagedown" | "cancel" | "interrupt" | "quit" | "refresh" };
const SEQUENCES: Record<string, InputAction["type"]> = {
  "\x1b[D": "left", "\x1b[C": "right", "\x1b[H": "home", "\x1b[F": "end",
  "\x1bOH": "home", "\x1bOF": "end", "\x1b[1~": "home", "\x1b[4~": "end",
  "\x1b[3~": "delete", "\x1b[5~": "pageup", "\x1b[6~": "pagedown",
};

/** Bounded incremental decoder. Bracketed paste is text, never commands or approval keys. */
export class InputDecoder {
  private escape = "";
  private paste: string | undefined;
  private pasteTail = "";

  flushEscape(): InputAction[] {
    const cancel = this.escape === "\x1b";
    this.escape = "";
    return cancel ? [{ type: "cancel" }] : [];
  }

  feed(text: string): InputAction[] {
    const result: InputAction[] = [];
    const insert = (value: string): void => {
      const last = result.at(-1);
      if (last?.type === "insert") last.text = (last.text + value).slice(0, MAX_DRAFT);
      else result.push({ type: "insert", text: value.slice(0, MAX_DRAFT) });
    };
    for (const char of text) {
      if (this.paste !== undefined) {
        this.pasteTail += char;
        if (this.pasteTail === "\x1b[201~") {
          insert(terminalText(this.paste).replace(/\n/g, " "));
          this.paste = undefined;
          this.pasteTail = "";
        } else if (!"\x1b[201~".startsWith(this.pasteTail)) {
          this.paste = (this.paste + this.pasteTail).slice(0, MAX_DRAFT);
          this.pasteTail = "";
        }
        continue;
      }
      if (this.escape) {
        this.escape += char;
        if (this.escape === "\x1b[200~") { this.paste = ""; this.escape = ""; continue; }
        const known = SEQUENCES[this.escape];
        if (known) { result.push({ type: known } as InputAction); this.escape = ""; continue; }
        const prefix = ["\x1b[200~", ...Object.keys(SEQUENCES)].some((value) => value.startsWith(this.escape));
        if (!prefix && (!this.escape.startsWith("\x1b[") || /[\x40-\x7e]$/.test(char) || this.escape.length >= 32)) this.escape = "";
        continue;
      }
      if (char === "\x1b") { this.escape = char; continue; }
      const key: Record<string, InputAction["type"]> = {
        "\r": "enter", "\n": "enter", "\x7f": "backspace", "\b": "backspace", "\t": "tab",
        "\x03": "interrupt", "\x04": "quit", "\x12": "refresh", "\x01": "home", "\x05": "end",
      };
      if (key[char]) result.push({ type: key[char] } as InputAction);
      else if (!/[\x00-\x1f\x7f-\x9f]/.test(char)) insert(terminalText(char));
    }
    return result;
  }
}
