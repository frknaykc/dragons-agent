const CREDENTIAL_KEYS = new Set([
  "api_key", "api-key", "apikey", "access_token", "access-token", "accesstoken",
  "refresh_token", "refresh-token", "refreshtoken", "token", "password", "secret",
  "credential", "authorization", "auth",
]);
const textDelimiter = /[\s"'`:=,{}\[\]&?]/;
const valueDelimiter = /[\s"'`,{}\[\]&]/;
const MAX_PENDING_TEXT = 8_192;

/** Incremental lexical redaction: incomplete keys and values never cross the public boundary. */
export class RuntimeTextRedactor {
  private mode: "text" | "key" | "start" | "value" | "quoted" = "text";
  private word = "";
  private pendingKey = "";
  private oversizedWord = false;
  private quote = "";
  private escaped = false;
  private valuePrefix = "";

  push(chunk: string): string {
    let output = "";
    const flushWord = (): void => {
      const lower = this.word.toLowerCase();
      if (this.oversizedWord) output += "[runtime text token truncated]";
      else if (CREDENTIAL_KEYS.has(lower)) {
        this.pendingKey = this.word;
        this.mode = "key";
      } else if (lower === "bearer" || lower === "basic") {
        output += this.word;
        this.mode = "start";
      } else output += /^(?:sk|rk)-/i.test(this.word) ? "[REDACTED]" : this.word;
      this.word = "";
      this.oversizedWord = false;
    };
    for (const character of chunk) {
      if (this.mode === "text") {
        if (!textDelimiter.test(character)) {
          if (this.word.length < MAX_PENDING_TEXT) this.word += character;
          else this.oversizedWord = true;
          continue;
        }
        flushWord();
      }
      if (this.mode === "key") {
        if (/[\s"'`]/.test(character)) {
          // Keep enough syntax for presentation without retaining unlimited whitespace.
          if (this.pendingKey.length < MAX_PENDING_TEXT) this.pendingKey += character;
          continue;
        }
        output += this.pendingKey;
        this.pendingKey = "";
        this.mode = character === ":" || character === "=" ? "start" : "text";
        if (this.mode === "start") { output += character; continue; }
      }
      if (this.mode === "start") {
        if (/\s/.test(character)) { output += character; continue; }
        output += "[REDACTED]";
        if (/["'`]/.test(character)) {
          this.quote = character;
          this.escaped = false;
          this.mode = "quoted";
        } else {
          this.mode = "value";
          this.valuePrefix = character;
        }
        continue;
      }
      if (this.mode === "quoted") {
        if (this.escaped) this.escaped = false;
        else if (character === "\\") this.escaped = true;
        else if (character === this.quote) this.mode = "text";
        continue;
      }
      if (this.mode === "value") {
        if (!valueDelimiter.test(character)) {
          if (this.valuePrefix.length < 7) this.valuePrefix += character;
          continue;
        }
        const scheme = /^(?:basic|bearer)$/i.test(this.valuePrefix);
        this.mode = scheme && /\s/.test(character) ? "start" : "text";
        this.valuePrefix = "";
        output += character;
        continue;
      }
      if (textDelimiter.test(character)) output += character;
      else this.word = character;
    }
    return output;
  }

  finish(): string {
    let output = "";
    if (this.mode === "text") {
      output = this.oversizedWord ? "[runtime text token truncated]"
        : /^(?:sk|rk)-/i.test(this.word) ? "[REDACTED]" : this.word;
    } else if (this.mode === "key") output = this.pendingKey;
    this.mode = "text";
    this.word = "";
    this.pendingKey = "";
    this.valuePrefix = "";
    this.oversizedWord = false;
    return output;
  }
}
