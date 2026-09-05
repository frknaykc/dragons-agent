import type { ReadStream } from "node:tty";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { DragonsRuntime } from "../runtime.js";
import { TuiController } from "./controller.js";
import { InputDecoder, type InputAction } from "./input.js";
import { graphemes, MAX_DRAFT, renderScreen, screenSize, type ViewState } from "./screen.js";

export type TuiInput = NodeJS.ReadableStream & Partial<Pick<ReadStream, "isTTY" | "isRaw" | "setRawMode">>;
export type TuiOutput = Writable & { isTTY?: boolean; columns?: number; rows?: number };
export type TuiOptions = {
  input?: TuiInput;
  output?: TuiOutput;
  resume?: string;
  provider?: string;
  model?: string;
};

/** Full-screen terminal adapter. No model, tool, store, or authorization policy lives here. */
export async function runTui(runtime: DragonsRuntime, options: TuiOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || !input.setRawMode) {
    await runtime.dispose();
    throw new Error("TUI requires a TTY on stdin and stdout. Use dragons without --tui for plain/headless mode.");
  }
  const view: ViewState = { draft: "", cursor: 0, scroll: 0, panel: "conversation", allowSelected: false };
  let timer: NodeJS.Timeout | undefined;
  let escapeTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let blocked = false;
  let previous: string[] = [];
  let approvalId: string | undefined;
  let presentedApprovalId: string | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const controller = new TuiController(runtime, schedule);
  const decoder = new InputDecoder();
  const utf8 = new StringDecoder("utf8");
  const wasRaw = input.isRaw ?? false;
  const wasFlowing = (input as { readableFlowing?: boolean | null }).readableFlowing === true;
  let terminalEntered = false;
  let stopPromise: Promise<void> | undefined;

  function schedule(): void {
    if (stopped || blocked || timer) return;
    timer = setTimeout(() => { timer = undefined; paint(); }, 33);
  }
  function paint(): void {
    if (stopped || blocked) return;
    if (approvalId !== controller.state.approval?.approvalId) {
      approvalId = controller.state.approval?.approvalId;
      view.allowSelected = false;
    }
    const frame = renderScreen(controller.state, view, output.columns ?? 80, output.rows ?? 24);
    let diff = "";
    frame.forEach((line, index) => {
      if (previous[index] !== line) diff += `\x1b[${index + 1};1H\x1b[2K${line}`;
    });
    previous = frame;
    if (diff) {
      try {
        blocked = !output.write(diff);
        presentedApprovalId = approvalId;
      }
      catch { void stop(); }
    }
  }
  function restore(): void {
    if (timer) clearTimeout(timer);
    if (escapeTimer) clearTimeout(escapeTimer);
    input.removeListener("data", data);
    input.removeListener("end", stopEvent);
    input.removeListener("close", stopEvent);
    input.removeListener("error", stopEvent);
    output.removeListener("resize", resize);
    output.removeListener("drain", drain);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stopEvent);
    try { input.setRawMode!(wasRaw); } catch { /* Continue restoring other owned modes. */ }
    if (!wasFlowing) input.pause();
    if (terminalEntered) {
      try { output.write("\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l"); } catch { /* Closed output cannot be restored. */ }
    }
  }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true;
    // Restore terminal before awaiting potentially slow provider cleanup.
    restore();
    stopPromise = controller.close().finally(finish);
    return stopPromise;
  }
  function stopEvent(): void { void stop().catch(() => {}); }
  function drain(): void { blocked = false; schedule(); }
  function resize(): void { previous = []; presentedApprovalId = undefined; view.allowSelected = false; schedule(); }
  function handle(action: InputAction): void {
    if (stopped) return;
    if (action.type === "quit") { stopEvent(); return; }
    if (action.type === "interrupt") {
      if (controller.state.busy) controller.cancel(); else stopEvent();
      return;
    }
    if (action.type === "cancel") { controller.cancel(); return; }
    if (controller.state.approval) {
      // No unseen or preselected approval on a new request, resize, or truncated frame.
      if (approvalId !== controller.state.approval.approvalId) { view.allowSelected = false; approvalId = controller.state.approval.approvalId; }
      const size = screenSize(output.columns ?? 80, output.rows ?? 24);
      if (size.width < 24 || size.height < 9 || blocked || presentedApprovalId !== controller.state.approval.approvalId) { view.allowSelected = false; return; }
      if (action.type === "tab") view.allowSelected = !view.allowSelected;
      if (action.type === "enter") { controller.decide(view.allowSelected ? "allow_once" : "deny"); view.allowSelected = false; }
      schedule();
      return;
    }
    if (action.type === "refresh") { void controller.refresh(); return; }
    if (action.type === "tab") { view.panel = view.panel === "conversation" ? "activity" : "conversation"; view.scroll = 0; }
    if (action.type === "pageup") view.scroll = Math.min(100_000, view.scroll + 10);
    if (action.type === "pagedown") view.scroll = Math.max(0, view.scroll - 10);
    if (!controller.state.busy) {
      const parts = graphemes(view.draft);
      if (action.type === "left") view.cursor = Math.max(0, view.cursor - 1);
      if (action.type === "right") view.cursor = Math.min(parts.length, view.cursor + 1);
      if (action.type === "home") view.cursor = 0;
      if (action.type === "end") view.cursor = parts.length;
      if (action.type === "backspace" && view.cursor) { parts.splice(--view.cursor, 1); view.draft = parts.join(""); }
      if (action.type === "delete") { parts.splice(view.cursor, 1); view.draft = parts.join(""); }
      if (action.type === "insert") {
        const added = action.text.replace(/\n/g, " ").slice(0, Math.max(0, MAX_DRAFT - view.draft.length));
        const before = parts.slice(0, view.cursor).join("") + added;
        view.draft = before + parts.slice(view.cursor).join("");
        view.cursor = graphemes(before).length;
      }
      if (action.type === "enter" && view.draft.trim()) {
        const content = view.draft;
        view.draft = ""; view.cursor = 0; view.scroll = 0; view.panel = "conversation";
        void controller.submit(content);
      }
    }
    schedule();
  }
  function data(chunk: Buffer | string): void {
    if (escapeTimer) clearTimeout(escapeTimer);
    for (const action of decoder.feed(typeof chunk === "string" ? chunk : utf8.write(chunk))) handle(action);
    escapeTimer = setTimeout(() => { for (const action of decoder.flushEscape()) handle(action); }, 80);
  }

  output.on("error", stopEvent);
  try {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stopEvent);
    input.on("data", data);
    input.on("end", stopEvent);
    input.on("close", stopEvent);
    input.on("error", stopEvent);
    output.on("resize", resize);
    output.on("drain", drain);
    input.setRawMode(true);
    terminalEntered = true;
    blocked = !output.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J");
    input.resume();
    paint();
    await controller.initialize({ resume: options.resume, provider: options.provider, model: options.model });
    schedule();
    await done;
  } finally {
    await stop().catch(() => {});
    output.removeListener("error", stopEvent);
  }
}
