import type { Writable } from "node:stream";

export type SecretTerminalInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
};
export type SecretTerminalOutput = Pick<Writable, "write"> & { isTTY?: boolean };

/** Exclusive terminal reader. The caller must close its readline interface first.
 * Never forwards input to readline, history, a renderer, or a diagnostic callback.
 */
export function readTerminalSecret(input: SecretTerminalInput, output: SecretTerminalOutput, signal: AbortSignal): Promise<string | undefined> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) {
    return Promise.reject(new Error("API-key entry requires a dedicated TTY on stdin and stdout. Never pass keys as arguments or chat text."));
  }
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const wasRaw = input.isRaw ?? false;
    const wasPaused = input.isPaused();
    const finish = (result?: string, failed = false): void => {
      if (finished) return;
      finished = true;
      value = "";
      input.removeListener("data", data);
      input.removeListener("end", cancel);
      input.removeListener("close", cancel);
      input.removeListener("error", fail);
      signal.removeEventListener("abort", cancel);
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
      try { input.setRawMode!(wasRaw); } catch { failed = true; }
      if (wasPaused) input.pause();
      try { output.write("\r\u001b[2K\n"); } catch { failed = true; }
      if (failed) reject(new Error("Secure terminal input failed."));
      else resolve(result);
    };
    const cancel = (): void => finish();
    const fail = (): void => finish(undefined, true);
    const data = (chunk: Buffer | string): void => {
      // Reject control sequences/paste framing rather than risk interpreting them as a key.
      for (const character of chunk.toString()) {
        if (finished) break;
        if (character === "\r" || character === "\n") { finish(value || undefined); break; }
        if (["\u001b", "\u0003", "\u0004"].includes(character)) { cancel(); break; }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (/^[\x21-\x7e]$/.test(character) && value.length < 8192) value += character;
        else { cancel(); break; }
      }
      if (!finished) {
        try { output.write(`\r\u001b[2KAPI key (Enter saves; Esc cancels): ${"*".repeat(Math.min(64, value.length))}`); }
        catch { fail(); }
      }
    };
    try {
      input.pause();
      input.setRawMode!(true);
      input.on("data", data);
      input.once("end", cancel);
      input.once("close", cancel);
      input.once("error", fail);
      signal.addEventListener("abort", cancel, { once: true });
      process.on("SIGINT", cancel);
      process.on("SIGTERM", cancel);
      output.write("API key (Enter saves; Esc cancels): ");
      input.resume();
    } catch { fail(); }
  });
}
