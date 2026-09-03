import { activateSkill, createSkillsContext, deactivateSkill, listSkills, readSkill } from "../skills.js";
import type { SkillReference } from "../skills.js";
import type { DragonsSession, SessionStore } from "../session-store.js";
import type { CliCommand } from "./commands.js";

export async function listAvailableSkills(directory: string, write: (text: string) => void): Promise<void> {
  const skills = await listSkills(directory);
  if (skills.length === 0) {
    write("No Dragons skills are available.\n");
    return;
  }
  for (const skill of skills) write(`${skill.id}  ${skill.name} — ${skill.description}\n`);
}

export function writeSkillNotices(notices: readonly string[], write: (text: string) => void): void {
  for (const notice of notices) write(`${notice}\n`);
}

export async function writeActiveSkillNotices(directory: string, references: readonly SkillReference[], write: (text: string) => void): Promise<void> {
  writeSkillNotices((await createSkillsContext(directory, references)).notices, write);
}

export async function runSkillsCommand(input: {
  command: Extract<CliCommand, { kind: "skills" }>;
  directory: string;
  sessionStore: SessionStore;
  write: (text: string) => void;
}): Promise<void> {
  const { command, directory, sessionStore, write } = input;
  if (command.action === "list") {
    await listAvailableSkills(directory, write);
    return;
  }
  if (command.action === "show") {
    const skill = await readSkill(directory, command.id);
    write(`${skill.id}  ${skill.name}\n${skill.description}\n\n${skill.body}\n`);
    return;
  }
  const session = await sessionStore.load(command.sessionId);
  if (!session) throw new Error(`Saved session was not found or is unreadable: ${command.sessionId}`);
  const skills = command.action === "activate"
    ? await activateSkill(directory, session.skills ?? [], command.id)
    : deactivateSkill(session.skills ?? [], command.id);
  await sessionStore.save({ ...session, updatedAt: new Date().toISOString(), skills });
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
  activeSkillReferences: SkillReference[];
  session: DragonsSession;
  sessionStore: SessionStore;
  write: (text: string) => void;
}): Promise<InteractiveSkillsResult> {
  const { task, directory, activeSkillReferences, session, sessionStore, write } = input;
  if (task === "/skills") {
    write(activeSkillReferences.length === 0 ? "No active skills.\n" : `Active skills: ${activeSkillReferences.map((reference) => reference.id).join(", ")}\n`);
    return { handled: true };
  }
  if (task === "/skills list") {
    await listAvailableSkills(directory, write);
    return { handled: true };
  }
  if (task.startsWith("/skills show ")) {
    const id = task.slice("/skills show ".length).trim();
    try {
      const skill = await readSkill(directory, id);
      write(`${skill.id}  ${skill.name}\n${skill.description}\n\n${skill.body}\n`);
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Unable to show skill."}\n`);
    }
    return { handled: true };
  }
  if (task.startsWith("/skills activate ")) {
    const id = task.slice("/skills activate ".length).trim();
    try {
      const skills = await activateSkill(directory, activeSkillReferences, id);
      const saved = { ...session, updatedAt: new Date().toISOString(), skills };
      await sessionStore.save(saved);
      write(`Activated skill: ${id}\n`);
      return { handled: true, activeSkillReferences: skills, session: saved };
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Unable to activate skill."}\n`);
    }
    return { handled: true };
  }
  if (task.startsWith("/skills deactivate ")) {
    const id = task.slice("/skills deactivate ".length).trim();
    try {
      const skills = deactivateSkill(activeSkillReferences, id);
      const saved = { ...session, updatedAt: new Date().toISOString(), skills };
      await sessionStore.save(saved);
      write(`Deactivated skill: ${id}\n`);
      return { handled: true, activeSkillReferences: skills, session: saved };
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Unable to deactivate skill."}\n`);
    }
    return { handled: true };
  }
  return { handled: false };
}
