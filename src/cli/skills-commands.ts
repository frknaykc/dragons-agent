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
  const project = command.scope === "project";
  const projectWorkspace = session.workingDirectory;
  if (project && !projectWorkspace) throw new Error("Project skills require a workspace.");
  const skills = command.action === "activate"
    ? project ? await activateProjectSkill(projectWorkspace, session.skills ?? [], command.id) : await activateSkill(directory, session.skills ?? [], command.id)
    : deactivateSkill(session.skills ?? [], command.id, project ? "PROJECT" : "USER");
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
  workingDirectory?: string;
  activeSkillReferences: SkillReference[];
  session: DragonsSession;
  sessionStore: SessionStore;
  write: (text: string) => void;
}): Promise<InteractiveSkillsResult> {
  const { task, directory, workingDirectory, activeSkillReferences, session, sessionStore, write } = input;
  if (task === "/skills") {
    write(activeSkillReferences.length === 0 ? "No active skills.\n" : `Active skills: ${activeSkillReferences.map((reference) => reference.id).join(", ")}\n`);
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
      const skills = project ? await activateProjectSkill(workingDirectory!, activeSkillReferences, id) : await activateSkill(directory, activeSkillReferences, id);
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
    const requested = task.slice("/skills deactivate ".length).trim();
    const project = requested.startsWith("project ");
    const id = project ? requested.slice("project ".length).trim() : requested;
    try {
      const skills = deactivateSkill(activeSkillReferences, id, project ? "PROJECT" : "USER");
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
