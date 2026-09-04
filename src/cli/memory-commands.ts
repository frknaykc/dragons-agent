import { createMemoryContext, createProjectMemoryScope, retrieveRelevantMemories } from "../memory.js";
import type { MemoryScope, MemoryStore } from "../memory.js";
import type { CliCommand } from "./commands.js";

export function formatMemorySuggestion(suggestion: { id: string; body: string; scope: MemoryScope; reason?: string }, interactive: boolean): string {
  const nextStep = interactive
    ? `Use /memory accept ${suggestion.id} or /memory reject ${suggestion.id}.`
    : "This suggestion is not persisted in non-interactive mode.";
  return `Pending ${suggestion.scope.kind.toLowerCase()} memory suggestion ${suggestion.id}:\n${suggestion.body}${suggestion.reason ? `\nReason: ${suggestion.reason}` : ""}\n${nextStep}\n`;
}

export async function memoryScopeFor(workingDirectory: string, scope: "user" | "project"): Promise<MemoryScope> {
  return scope === "project" ? createProjectMemoryScope(workingDirectory) : { kind: "USER" };
}

export async function listMemories(store: MemoryStore, write: (text: string) => void, scope: MemoryScope): Promise<void> {
  const memories = await store.list(scope);
  if (memories.length === 0) {
    write(`No saved ${scope.kind.toLowerCase()} Dragons memories.\n`);
    return;
  }
  for (const memory of memories) write(`${memory.id}  ${memory.createdAt}  ${memory.scope.kind}\n${memory.body}\n`);
}

export async function memoryContextFor(store: MemoryStore, workingDirectory: string, task: string) {
  const projectScope = await createProjectMemoryScope(workingDirectory);
  const [userMemories, projectMemories] = await Promise.all([
    store.list({ kind: "USER" }),
    store.list(projectScope),
  ]);
  return createMemoryContext(retrieveRelevantMemories([...userMemories, ...projectMemories], task, projectScope));
}

export async function runMemoryCommand(input: {
  command: Extract<CliCommand, { kind: "memory" }>;
  store: MemoryStore;
  workingDirectory: string;
  write: (text: string) => void;
}): Promise<void> {
  const scope = await memoryScopeFor(input.workingDirectory, input.command.scope);
  if (input.command.action === "list") {
    await listMemories(input.store, input.write, scope);
    return;
  }
  if (input.command.action === "show") {
    const memory = await input.store.get(input.command.id, scope);
    if (memory) input.write(`${memory.id}  ${memory.createdAt}  ${memory.scope.kind}\n${memory.body}\n`);
    else input.write(`Memory was not found: ${input.command.id}\n`);
    return;
  }
  if (input.command.action === "add") {
    const memory = await input.store.add({ body: input.command.body, scope });
    input.write(`Added ${memory.scope.kind.toLowerCase()} memory: ${memory.id}\n`);
    return;
  }
  if (input.command.action === "suggest") {
    const suggestion = await input.store.suggest({ body: input.command.body, scope });
    input.write(formatMemorySuggestion(suggestion, false));
    return;
  }
  if (await input.store.delete(input.command.id, scope)) input.write(`Deleted ${input.command.scope} memory: ${input.command.id}\n`);
  else input.write(`Memory was not found: ${input.command.id}\n`);
}

export async function handleInteractiveMemoryCommand(input: {
  task: string;
  store: MemoryStore;
  workingDirectory: string;
  write: (text: string) => void;
}): Promise<boolean> {
  const { task, store, workingDirectory, write } = input;
  if (task === "/memory" || task === "/memory list" || task === "/memory list user" || task === "/memory list project") {
    const scope = task.endsWith(" project") ? "project" : "user";
    try { await listMemories(store, write, await memoryScopeFor(workingDirectory, scope)); }
    catch (error: unknown) { write(`${error instanceof Error ? error.message : "Unable to list memories."}\n`); }
    return true;
  }
  if (task.startsWith("/memory show ")) {
    const [id, scopeName] = task.slice("/memory show ".length).trim().split(/\s+/, 2);
    const scope = scopeName === "project" ? "project" : "user";
    try {
      const memory = await store.get(id ?? "", await memoryScopeFor(workingDirectory, scope));
      if (memory) write(`${memory.id}  ${memory.createdAt}  ${memory.scope.kind}\n${memory.body}\n`);
      else write(`Memory was not found: ${id ?? ""}\n`);
    } catch (error: unknown) { write(`${error instanceof Error ? error.message : "Unable to show memory."}\n`); }
    return true;
  }
  if (task.startsWith("/memory add ")) {
    const raw = task.slice("/memory add ".length).trim();
    const [scopeName, ...rest] = raw.split(/\s+/);
    const scope = scopeName === "project" ? "project" : "user";
    const body = (scopeName === "user" || scopeName === "project" ? rest : [scopeName, ...rest]).join(" ").trim();
    try {
      const memory = await store.add({ body, scope: await memoryScopeFor(workingDirectory, scope) });
      write(`Added ${memory.scope.kind.toLowerCase()} memory: ${memory.id}\n`);
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Unable to add memory."}\n`);
    }
    return true;
  }
  if (task.startsWith("/memory suggest ")) {
    const raw = task.slice("/memory suggest ".length).trim();
    const [scopeName, ...rest] = raw.split(/\s+/);
    const scope = scopeName === "project" ? "project" : "user";
    const body = (scopeName === "user" || scopeName === "project" ? rest : [scopeName, ...rest]).join(" ").trim();
    try {
      const suggestion = await store.suggest({ body, scope: await memoryScopeFor(workingDirectory, scope) });
      write(formatMemorySuggestion(suggestion, true));
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Unable to suggest memory."}\n`);
    }
    return true;
  }
  if (task.startsWith("/memory accept ")) {
    const id = task.slice("/memory accept ".length).trim();
    try {
      const memory = await store.acceptSuggestion(id);
      if (memory) write(`Accepted ${memory.scope.kind.toLowerCase()} memory suggestion: ${memory.id}\n`);
      else write(`Pending memory suggestion was not found: ${id}\n`);
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Unable to accept memory suggestion."}\n`);
    }
    return true;
  }
  if (task.startsWith("/memory reject ")) {
    const id = task.slice("/memory reject ".length).trim();
    if (await store.rejectSuggestion(id)) write(`Rejected memory suggestion: ${id}\n`);
    else write(`Pending memory suggestion was not found: ${id}\n`);
    return true;
  }
  if (task.startsWith("/memory delete ")) {
    const [id, scopeName] = task.slice("/memory delete ".length).trim().split(/\s+/, 2);
    const scope = scopeName === "project" ? "project" : "user";
    try {
      if (await store.delete(id ?? "", await memoryScopeFor(workingDirectory, scope))) write(`Deleted ${scope} memory: ${id}\n`);
      else write(`Memory was not found: ${id ?? ""}\n`);
    } catch (error: unknown) { write(`${error instanceof Error ? error.message : "Unable to delete memory."}\n`); }
    return true;
  }
  return false;
}
