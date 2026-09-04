import { activateProjectSkill, activateSkill, createSkillsContext, deactivateSkill, getProjectSkillsDirectory, listProjectSkills, listSkills, readProjectSkill, readSkill } from "../skills.js";
import type { SkillReference } from "../skills.js";
import type { DragonsSession, SessionStore } from "../session-store.js";
import type { CliCommand } from "./commands.js";

export async function listAvailableSkills(directory: string, write: (text: string) => void, workspace?: string): Promise<void> {
  const skills = [...await listSkills(directory), ...(workspace ? await listProjectSkills(workspace) : [])];
  if (skills.length === 0) {
    write("No Dragons skills are available.\n");
    return;
  }
  for (const skill of skills) write(`${skill.scope}  ${skill.id}  ${skill.name} — ${skill.description}\n`);
}

export function writeSkillNotices(notices: readonly string[], write: (text: string) => void): void {
  for (const notice of notices) write(`${notice}\n`);
}

async function saveSessionSkills(sessionStore: SessionStore, session: DragonsSession, resolve: (current: DragonsSession) => Promise<SkillReference[]>): Promise<DragonsSession> {
  const update = async (current: DragonsSession): Promise<DragonsSession> => ({ ...current, updatedAt: new Date().toISOString(), skills: await resolve(current) });
  const saved = sessionStore.mutate
    ? await sessionStore.mutate(session.id, update)
    : await (async () => { const next = await update(session); await sessionStore.save(next); return next; })();
  if (!saved) throw new Error(`Saved session was not found or is unreadable: ${session.id}`);
  return saved;
}

export async function writeActiveSkillNotices(directory: string, references: readonly SkillReference[], write: (text: string) => void, workspace?: string): Promise<void> {
  writeSkillNotices((await createSkillsContext(directory, references, workspace)).notices, write);
}

export async function runSkillsCommand(input: {
  command: Extract<CliCommand, { kind: "skills" }>;
  directory: string;
  workingDirectory?: string;
  sessionStore: SessionStore;
  write: (text: string) => void;
}): Promise<void> {
  const { command, directory, workingDirectory, sessionStore, write } = input;
  if (command.action === "list") {
    await listAvailableSkills(directory, write, workingDirectory);
    return;
  }
  if (command.action === "show") {
    if (command.scope === "project" && !workingDirectory) throw new Error("Project skills require a workspace.");
    const skill = command.scope === "project" ? await readProjectSkill(workingDirectory!, command.id) : await readSkill(directory, command.id);
    write(`${skill.id}  ${skill.name}\n${skill.description}\n\n${skill.body}\n`);
    return;
  }
  const session = await sessionStore.load(command.sessionId);
  if (!session) throw new Error(`Saved session was not found or is unreadable: ${command.sessionId}`);
  const saved = await saveSessionSkills(sessionStore, session, async (current) => {
    const project = command.scope === "project";
    if (project && !current.workingDirectory) throw new Error("Project skills require a workspace.");
    return command.action === "activate"
      ? project ? await activateProjectSkill(current.workingDirectory, current.skills ?? [], command.id) : await activateSkill(directory, current.skills ?? [], command.id)
      : deactivateSkill(current.skills ?? [], command.id, project ? "PROJECT" : "USER");
  });
  write(`${command.action === "activate" ? "Activated" : "Deactivated"} skill: ${command.id}\n`);
}

export type InteractiveSkillsResult = {
  handled: boolean;
  activeSkillReferences?: SkillReference[];
  session?: DragonsSession;
};

export async function handleInteractiveSkillsCommand(input: {
  task: string;
  directory: string;
  workingDirectory?: string;
  activeSkillReferences: SkillReference[];
  session: DragonsSession;
  sessionStore: SessionStore;
  write: (text: string) => void;
}): Promise<InteractiveSkillsResult> {
  const { task, directory, workingDirectory, activeSkillReferences, session, sessionStore, write } = input;
  if (task === "/skills") {
    const counts = new Map<string, number>();
    for (const reference of activeSkillReferences) counts.set(reference.id, (counts.get(reference.id) ?? 0) + 1);
    write(activeSkillReferences.length === 0 ? "No active skills.\n" : `Active skills: ${activeSkillReferences.map((reference) => (counts.get(reference.id) ?? 0) > 1 ? `${reference.scope ?? "USER"}:${reference.id}` : reference.id).join(", ")}\n`);
    return { handled: true };
  }
  if (task === "/skills list") {
    await listAvailableSkills(directory, write, workingDirectory);
    return { handled: true };
  }
  if (task.startsWith("/skills show ")) {
    const requested = task.slice("/skills show ".length).trim();
    const project = requested.startsWith("project ");
    const id = project ? requested.slice("project ".length).trim() : requested;
    try {
      if (project && !workingDirectory) throw new Error("Project skills require a workspace.");
      const skill = project ? await readProjectSkill(workingDirectory!, id) : await readSkill(directory, id);
      write(`${skill.id}  ${skill.name}\n${skill.description}\n\n${skill.body}\n`);
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Unable to show skill."}\n`);
    }
    return { handled: true };
  }
  if (task.startsWith("/skills activate ")) {
    const requested = task.slice("/skills activate ".length).trim();
    const project = requested.startsWith("project ");
    const id = project ? requested.slice("project ".length).trim() : requested;
    try {
      if (project && !workingDirectory) throw new Error("Project skills require a workspace.");
      const saved = await saveSessionSkills(sessionStore, session, async (current) => project ? await activateProjectSkill(workingDirectory!, current.skills ?? [], id) : await activateSkill(directory, current.skills ?? [], id));
      write(`Activated skill: ${id}\n`);
      return { handled: true, activeSkillReferences: saved.skills ?? [], session: saved };
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Unable to activate skill."}\n`);
    }
    return { handled: true };
  }
  if (task.startsWith("/skills deactivate ")) {
    const requested = task.slice("/skills deactivate ".length).trim();
    const project = requested.startsWith("project ");
    const id = project ? requested.slice("project ".length).trim() : requested;
    try {
      const saved = await saveSessionSkills(sessionStore, session, async (current) => deactivateSkill(current.skills ?? [], id, project ? "PROJECT" : "USER"));
      write(`Deactivated skill: ${id}\n`);
      return { handled: true, activeSkillReferences: saved.skills ?? [], session: saved };
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Unable to deactivate skill."}\n`);
    }
    return { handled: true };
  }
  return { handled: false };
}
