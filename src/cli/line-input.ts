import { createInterface, emitKeypressEvents, moveCursor, type Key } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { SlashPicker, type SlashChoice } from "../slash-choices.js";

export type LineInput = {
  next(): Promise<IteratorResult<string>>;
  composer(): void;
  approval(): void;
  close(): void;
};
type TerminalInput = NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (enabled: boolean) => unknown };

/** Line-oriented keyboard adapter: public readline editing, no private key hooks or screen loop.
 * A private decoder stream can be destroyed before masked entry, leaving no stdin observer.
 */
export function createLineInput(options: {
  input: TerminalInput;
  write: (text: string) => void;
  terminal: boolean;
  columns?: number;
  resizeSource?: NodeJS.EventEmitter & { columns?: number };
  choices: (line: string) => SlashChoice[];
  interrupt: () => void;
}): LineInput {
  const { input } = options;
  if (!options.terminal || !input.isTTY || !input.setRawMode) {
    const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
    const answers = lines[Symbol.asyncIterator]();
    return { next: () => answers.next(), composer() {}, approval() {}, close: () => lines.close() };
  }
  const readWidth = (): number => {
    const columns = options.resizeSource?.columns ?? options.columns;
    return Number.isFinite(columns) && columns! >= 1 ? Math.floor(columns!) : 80;
  };
  let width = readWidth();
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { options.write(String(chunk)); done(); } }), { columns: width });
  const editorInput = new PassThrough();
  const decoder = new PassThrough();
  const editor = createInterface({ input: editorInput, output, terminal: true, prompt: "  › ", historySize: 0 });
  const picker = new SlashPicker();
  let mode: "composer" | "approval" | "busy" = "busy";
  let closed = false;
  let overlayRows = 0;
  let inserted = false;
  let pending: ((value: IteratorResult<string>) => void) | undefined;
  const queue: string[] = [];
  const wasRaw = input.isRaw ?? false;
  const wasPaused = input.isPaused();
  const choices = (): SlashChoice[] => mode === "composer" && !picker.dismissed && editor.cursor === editor.line.length
    ? options.choices(editor.line) : [];
  const clear = (): void => {
    if (!overlayRows) return;
    const column = editor.getCursorPos().cols;
    for (let i = 0; i < overlayRows; i++) options.write("\n\r\u001b[2K");
    options.write(`\u001b[${overlayRows}A\u001b[${column + 1}G`);
    overlayRows = 0;
  };
  const draw = (): void => {
    const available = choices();
    if (!available.length) return;
    const selected = picker.selected % available.length;
    const start = Math.floor(selected / 6) * 6;
    const rows = available.slice(start, start + 6).map((choice, index) =>
      `${start + index === selected ? ">" : " "} ${choice.value} — ${choice.description}`);
    rows.push("Up/Down choose | Tab/Enter insert | Enter again submits | Esc dismisses");
    const column = editor.getCursorPos().cols;
    for (const row of rows) {
      // Metadata is untrusted display text; printable ASCII also gives exact bounded cell widths.
      options.write(`\n\r\u001b[2K${row.replace(/[^\x20-\x7e]/g, " ").slice(0, Math.max(0, width - 1))}`);
    }
    overlayRows = rows.length;
    options.write(`\u001b[${overlayRows}A\u001b[${column + 1}G`);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    clear();
    options.resizeSource?.removeListener("resize", resize);
    input.removeListener("data", data);
    input.removeListener("end", close);
    input.removeListener("close", close);
    input.removeListener("error", close);
    decoder.removeListener("keypress", keypress);
    decoder.destroy();
    editor.close();
    editorInput.destroy();
    output.destroy();
    queue.length = 0;
    input.setRawMode!(wasRaw);
    // A fresh stdin is neither paused nor flowing. Removing its last listener alone
    // does not undo resume(); pause it or the terminal handle keeps Node alive.
    if (wasPaused || input.listenerCount("data") === 0) input.pause();
    pending?.({ done: true, value: undefined });
    pending = undefined;
  };
  editor.on("line", (value: string) => {
    mode = "busy";
    picker.reset();
    if (pending) { const resolve = pending; pending = undefined; resolve({ done: false, value }); }
    else queue.push(value);
  });
  editor.on("close", close);
  const keypress = (text: string | undefined, key: Key): void => {
    if (closed) return;
    clear();
    if (key.ctrl && key.name === "c") {
      if (mode !== "busy") editor.write(null, { ctrl: true, name: "u" });
      picker.reset();
      options.interrupt();
      return;
    }
    if (mode === "busy") return;
    const available = choices();
    const name = key.name === "return" ? "enter" : key.name === "escape" ? "cancel" : key.name;
    if (name === "cancel") { picker.key("cancel", available); return; }
    if (available.length && ["up", "down", "enter", "tab"].includes(name ?? "") &&
      !(inserted && name === "enter") && !key.ctrl && !key.meta) {
      inserted = false;
      const value = picker.key(name!, available);
      if (value !== undefined) {
        editor.write(null, { ctrl: true, name: "u" });
        editor.write(value);
        // Show argument choices after command insertion, but another Enter submits the inserted
        // text. Navigation/Tab explicitly enters the argument picker instead.
        picker.reset();
        inserted = true;
      }
      draw();
      return;
    }
    const previous = editor.line;
    editor.write(text ?? null, key);
    if (previous !== editor.line) { picker.reset(); inserted = false; }
    draw();
  };
  const data = (chunk: string | Buffer): void => { decoder.write(chunk); };
  const resize = (): void => {
    if (closed) return;
    const nextWidth = readWidth();
    if (nextWidth === width) return;
    const previousRow = editor.getCursorPos().rows;
    output.columns = width = nextWidth;
    // Approval's external question and run/auth output are not owned by this
    // editor. Refresh only the live composer, never erase those surfaces.
    if (mode !== "composer") return;
    // Terminal reflow has already moved the cursor. Public readline's resize
    // refresh still subtracts its OLD row count: compensate without private hooks.
    // Its clear-screen-down removes all reflowed picker rows, not just their old
    // logical count, and establishes fresh editing/cursor bookkeeping.
    const correction = previousRow - editor.getCursorPos().rows;
    // CSI down clamps at the viewport bottom. Newlines allocate the temporary
    // rows on growth so readline can safely move back up even at that edge.
    if (correction > 0) output.write("\n".repeat(correction));
    else moveCursor(output, 0, correction);
    overlayRows = 0;
    output.emit("resize");
    draw();
  };
  emitKeypressEvents(decoder);
  decoder.on("keypress", keypress);
  input.on("data", data);
  input.once("end", close);
  input.once("close", close);
  input.once("error", close);
  options.resizeSource?.on("resize", resize);
  input.setRawMode(true);
  input.resume();
  return {
    next: () => {
      if (queue.length) return Promise.resolve({ done: false, value: queue.shift()! });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => { pending = resolve; });
    },
    composer() {
      if (closed) return;
      mode = "composer";
      picker.reset();
      inserted = false;
      // Replace the renderer's placeholder row with the single live readline surface.
      options.write("\r\u001b[2K");
      editor.setPrompt("  › ");
      editor.prompt();
    },
    approval() { clear(); mode = "approval"; picker.reset(); editor.setPrompt(""); },
    close,
  };
}
