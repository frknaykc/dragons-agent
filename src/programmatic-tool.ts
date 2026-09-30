import type { AgentTool, ToolResult } from "./tools.js";

export const PROGRAM_TOOL_NAME = "execute_program";
const MAX_PROGRAM_BYTES = 16_384;
const MAX_STEPS = 64;
const MAX_CALLS = 24;
const MAX_ITEMS = 20;
const MAX_VALUE_BYTES = 16_384;
const MAX_OUTPUT_BYTES = 24_576;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bounded(value: unknown, max = MAX_VALUE_BYTES): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text, "utf8") > max) throw new Error("Program value exceeds size limit.");
  return JSON.parse(text) as unknown;
}
function name(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(value) && value !== "__proto__" && value !== "constructor" && value !== "prototype";
}
function reference(value: unknown, state: Map<string, unknown>): unknown {
  if (typeof value !== "string" || value.length > 256) throw new Error("Invalid program reference.");
  const parts = value.split(".");
  if (parts.some(part => !name(part))) throw new Error("Invalid program reference.");
  if (!state.has(parts[0]!)) throw new Error(`Unknown program variable: ${parts[0]}.`);
  let result = state.get(parts[0]!);
  for (const part of parts.slice(1)) {
    if (!object(result) || !Object.hasOwn(result, part)) throw new Error("Program reference path not found.");
    result = result[part];
  }
  return result;
}
function resolve(value: unknown, state: Map<string, unknown>, depth = 0): unknown {
  if (depth > 8) throw new Error("Program value nesting limit exceeded.");
  if (object(value)) {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "$ref")) return reference(value.$ref, state);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry, state, depth + 1)]));
  }
  if (Array.isArray(value)) return value.map(entry => resolve(entry, state, depth + 1));
  return value;
}

/** Pure declarative interpreter: no JS evaluation, host objects, filesystem or network handles. */
export async function runProgram(input: unknown, invoke: (tool: string, args: string) => Promise<ToolResult>, signal?: AbortSignal): Promise<ToolResult> {
  let stepsRun = 0;
  let callsRun = 0;
  const state = new Map<string, unknown>();
  try {
    bounded(input, MAX_PROGRAM_BYTES);
    if (!object(input) || !Array.isArray(input.steps) || input.steps.length > 16 || input.steps.length === 0) throw new Error("Expected 1-16 program steps.");
    const steps = async (list: unknown[], depth: number): Promise<void> => {
      if (depth > 2) throw new Error("Program loop depth limit exceeded.");
      for (const raw of list) {
        if (signal?.aborted) throw new Error("Program cancelled.");
        if (++stepsRun > MAX_STEPS) throw new Error("Program step limit exceeded.");
        if (!object(raw) || !name(raw.as) || state.size >= 32 && !state.has(raw.as)) throw new Error("Invalid or excessive program variable.");
        let value: unknown;
        if (raw.op === "call") {
          if (typeof raw.tool !== "string" || !raw.tool || raw.tool === PROGRAM_TOOL_NAME) throw new Error("Invalid nested tool.");
          if (++callsRun > MAX_CALLS) throw new Error("Program tool call limit exceeded.");
          const args = JSON.stringify(resolve(raw.args ?? {}, state));
          if (Buffer.byteLength(args, "utf8") > MAX_VALUE_BYTES) throw new Error("Nested tool arguments exceed size limit.");
          const result = await invoke(raw.tool, args);
          if (!result.ok) throw new Error(`Nested tool ${raw.tool} failed: ${result.output.slice(0, 1024)}`);
          if (Buffer.byteLength(result.output, "utf8") > MAX_VALUE_BYTES) throw new Error("Nested tool output exceeds program value limit.");
          const observation: Record<string, unknown> = { ok: true, output: result.output };
          try { observation.data = bounded(JSON.parse(result.output) as unknown); } catch { /* Text results remain available as output. */ }
          value = observation;
        } else if (raw.op === "filter") {
          const source = reference(raw.from, state);
          if (!Array.isArray(source) || source.length > MAX_ITEMS || !name(raw.field)) throw new Error("Filter requires a bounded array and field.");
          const match = bounded(resolve(raw.equals, state));
          value = source.filter(entry => object(entry) && Object.hasOwn(entry, raw.field as string) && JSON.stringify(entry[raw.field as string]) === JSON.stringify(match));
        } else if (raw.op === "aggregate") {
          const source = reference(raw.from, state);
          if (!Array.isArray(source) || source.length > MAX_ITEMS) throw new Error("Aggregate requires a bounded array.");
          if (raw.kind === "count") value = source.length;
          else if (raw.kind === "sum" && name(raw.field)) {
            const numbers = source.map(entry => object(entry) ? entry[raw.field as string] : undefined);
            if (numbers.some(entry => typeof entry !== "number" || !Number.isFinite(entry))) throw new Error("Sum requires finite numeric fields.");
            const sum = (numbers as number[]).reduce((total, entry) => total + entry, 0);
            if (!Number.isFinite(sum)) throw new Error("Sum exceeds numeric range.");
            value = sum;
          } else if (raw.kind === "collect" && name(raw.field)) value = source.map(entry => object(entry) ? entry[raw.field as string] : undefined);
          else throw new Error("Invalid aggregate operation.");
        } else if (raw.op === "each") {
          const source = reference(raw.from, state);
          if (!Array.isArray(source) || source.length > MAX_ITEMS || !name(raw.item) || !Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 8) throw new Error("Loop requires a bounded array, item and 1-8 steps.");
          const previous = state.has(raw.item) ? state.get(raw.item) : undefined;
          const results: unknown[] = [];
          for (const item of source) {
            state.set(raw.item, item);
            await steps(raw.steps, depth + 1);
            results.push(state.get((raw.steps.at(-1) as Record<string, unknown>).as as string));
          }
          if (previous === undefined) state.delete(raw.item); else state.set(raw.item, previous);
          value = results;
        } else throw new Error("Unknown program step operation.");
        state.set(raw.as, bounded(value));
      }
    };
    await steps(input.steps, 0);
    if (signal?.aborted) throw new Error("Program cancelled.");
    const result = input.return === undefined ? state.get((input.steps.at(-1) as Record<string, unknown>).as as string) : reference(input.return, state);
    return { ok: true, output: JSON.stringify(bounded(result, MAX_OUTPUT_BYTES)) };
  } catch (error: unknown) {
    return { ok: false, output: error instanceof Error ? error.message.slice(0, 1200) : "Program failed." };
  }
}

export function createProgramTool(): AgentTool {
  return {
    name: PROGRAM_TOOL_NAME, operation: "READ",
    description: "Run bounded declarative JSON steps (call, filter, each, aggregate) over isolated per-call state. Nested calls follow the same runtime permission boundary; no JavaScript or OS sandbox. Each step has 'as'; call has tool/args and stores {ok,output,data?}; filter has from/field/equals; each has from/item/steps; aggregate has from/kind (count, sum, collect)/field. References use {$ref:'variable.path'} in args/equals or a dotted string in from/return. Maximum 64 executed steps, 24 nested calls, 20 items per array, 16 KiB values.",
    inputSchema: { type: "object", properties: { steps: { type: "array", description: "1-16 declarative steps", items: { type: "object" } }, return: { type: "string", description: "Optional dotted result reference" } }, required: ["steps"], additionalProperties: false },
    execute: async () => ({ ok: false, output: "Program execution requires runAgent authority." }),
  };
}
