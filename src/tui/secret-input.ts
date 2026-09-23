import type { InputAction } from "./input.js";

/** Secret remains private to the dedicated widget, never in composer/controller state. */
export class SecretInput {
  #value = "";
  #finish?: (value: string | undefined) => void;
  get active(): boolean { return this.#finish !== undefined; }
  get mask(): string { return "API key (Enter saves; Esc cancels): " + "*".repeat(Math.min(64, this.#value.length)); }
  request(signal: AbortSignal, changed: () => void): Promise<string | undefined> {
    if (this.active || signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const abort = (): void => this.cancel();
      this.#finish = (value) => {
        this.#value = "";
        this.#finish = undefined;
        signal.removeEventListener("abort", abort);
        resolve(value);
        changed();
      };
      signal.addEventListener("abort", abort, { once: true });
      changed();
    });
  }
  cancel(): void { this.#finish?.(undefined); }
  handle(action: InputAction): void {
    if (!this.active) return;
    if (["cancel", "interrupt", "quit"].includes(action.type)) this.cancel();
    else if (action.type === "enter") this.#finish?.(this.#value || undefined);
    else if (action.type === "backspace") this.#value = this.#value.slice(0, -1);
    else if (action.type === "insert") this.#value = (this.#value + action.text).slice(0, 8192);
  }
}
