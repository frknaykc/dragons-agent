export type SlashCommandHelp = {
  name: string;
  aliases?: readonly string[];
  usage?: string;
  description: string;
  group: "Session" | "Configuration" | "Info" | "Tools" | "Exit";
};

/**
 * User-facing commands are local UI controls, never model prompts. This catalog is
 * shared by CLI/TUI/Desktop presentations; each presentation binds only commands
 * backed by its own trusted runtime.
 */
export const SLASH_COMMANDS: readonly SlashCommandHelp[] = [
  { group: "Session", name: "/new", aliases: ["/reset"], usage: "/new", description: "Start a new session." },
  { group: "Session", name: "/clear", usage: "/clear", description: "Clear the current conversation." },
  { group: "Session", name: "/sessions", usage: "/sessions", description: "List saved sessions." },
  { group: "Session", name: "/resume", usage: "/resume <id>", description: "Resume a saved session." },
  { group: "Session", name: "/worktree", usage: "/worktree <create|select> <name>", description: "Create or select an isolated Git worktree; Desktop requires reopen to switch." },
  { group: "Configuration", name: "/login", usage: "/login <provider>", description: "Choose provider sign-in or supported API-key setup." },
  { group: "Configuration", name: "/logout", usage: "/logout [provider]", description: "Sign out or remove the selected provider's stored API key." },
  { group: "Configuration", name: "/auth", usage: "/auth [status] [provider]", description: "Show local credential status, not account access." },
  { group: "Configuration", name: "/profile", usage: "/profile [list|create <name>|select <name>]", description: "List, create, or select an isolated profile." },
  { group: "Configuration", name: "/reasoning", usage: "/reasoning [default|level]", description: "Show or save verified model reasoning effort for this profile." },
  { group: "Configuration", name: "/model", usage: "/model [name]", description: "Show or change the current model." },
  { group: "Configuration", name: "/provider", usage: "/provider [id]", description: "Show or change the current provider." },
  { group: "Info", name: "/status", aliases: ["/session"], usage: "/status", description: "Show the current session." },
  { group: "Info", name: "/context", usage: "/context", description: "Show context budget usage." },
  { group: "Info", name: "/diagnostics", usage: "/diagnostics", description: "Show runtime diagnostics." },
  { group: "Info", name: "/help", usage: "/help [filter]", description: "Show available commands." },
  { group: "Tools", name: "/checkpoint", usage: "/checkpoint [list|diff <id> [--page <n>] [path]]", description: "Inspect exact session-only file snapshots; follow next page; JSON-quote whitespace paths." },
  { group: "Tools", name: "/rollback", usage: "/rollback <id> [path]", description: "Restore selected checkpoint files after WRITE approval; refuse external-edit conflicts." },
  { group: "Tools", name: "/skills", usage: "/skills <subcommand>", description: "Manage active skills." },
  { group: "Tools", name: "/memory", usage: "/memory <subcommand>", description: "Manage advisory memory." },
  { group: "Tools", name: "/plan", usage: "/plan <subcommand>", description: "Manage the session plan." },
  { group: "Tools", name: "/mcp", usage: "/mcp <subcommand>", description: "Manage MCP connections." },
  { group: "Tools", name: "/tasks", usage: "/tasks <subcommand>", description: "Manage background tasks." },
  { group: "Tools", name: "/jobs", usage: "/jobs <subcommand>", description: "Manage persistent background jobs." },
  { group: "Tools", name: "/cron", usage: "/cron [list|status|once <UTC ISO timestamp> -- <prompt>|add <five UTC cron fields> -- <prompt>|pause <id>|resume <id>|trigger <id>|remove <id>]", description: "Manage scheduled read-only tasks for this Desktop workspace. Creation accepts optional --skill user|project <id> before -- <prompt>." },
  { group: "Tools", name: "/goal", usage: "/goal [list|status <id>|add <max-turns> <UTC ISO deadline> -- <objective> -- <criterion>|run <id>|pause <id>|resume <id>|interrupt <id>|complete <id>]", description: "Manage persistent READ-only goals in this session; runs require a command and completion requires your explicit verification." },
  { group: "Tools", name: "/kanban", usage: "/kanban [list|status <id>|add <assignee> -- <title>|assign <id> <revision> <assignee>|depend <id> <revision> <dependency-id>|progress <id> <revision> <todo|doing|blocked|done> <0-100>|handoff offer <id> <revision> <profile>|handoff accept <id> <revision>|handoff cancel <id> <revision>|lock status|lock recover|lane lock status|lane lock recover|worker recover <id> <revision> <pid>|worker start <id> <revision>|worker lane <id>:<revision> [<id>:<revision> ...]]", description: "Manage shared workspace tasks; handoff needs target acceptance. Explicit Local worker start or bounded lane uses separate READ-only processes in CLI or Desktop. Recovery needs typed confirmation; Desktop uses /kanban lane lock confirm RECOVER or /kanban worker confirm RECOVER within 60 seconds." },
  { group: "Tools", name: "/moa", usage: "/moa <duo|trio|quartet> <provider>... --aggregate <provider> -- <question>", description: "CLI only: after SHARE confirmation run 2–4 selected READ-only providers and synthesize their reports without tools." },
  { group: "Tools", name: "/batch", usage: "/batch [list|status <id>|add <max-runs> -- <task> [-- <task> ...]|run <id> <revision>|recover <id> <revision>|lock status|lock recover]", description: "Checkpoint up to 8 READ-only tasks; RUN confirmation starts fresh models, RECOVER marks a stopped owner's task interrupted." },
  { group: "Tools", name: "/loop", usage: "/loop [status|stop|start <interval-seconds> <max-runs> -- <prompt>]", description: "Run bounded, session-local READ-only turns while Desktop or interactive CLI remains open." },
  { group: "Tools", name: "/heartbeat", usage: "/heartbeat [status|stop|start <interval-seconds> <idle-seconds> <max-runs> -- <prompt>]", description: "Run bounded READ-only turns after inactivity while Desktop or interactive CLI remains open." },
  { group: "Exit", name: "/exit", aliases: ["/quit"], usage: "/exit", description: "Exit Dragons." },
];

export function formatSlashHelp(filter?: string, available: readonly string[] = SLASH_COMMANDS.map((command) => command.name)): string {
  const needle = filter?.trim().toLowerCase();
  const supported = SLASH_COMMANDS.filter((command) => available.includes(command.name));
  const commands = needle
    ? supported.filter((command) => [command.name, ...(command.aliases ?? []), command.description, command.usage ?? ""].join(" ").toLowerCase().includes(needle))
    : supported;
  if (commands.length === 0) return `No slash commands match: ${filter?.trim() ?? ""}. Run /help.\n`;
  const groups = ["Session", "Configuration", "Info", "Tools", "Exit"] as const;
  const lines = ["Commands:"];
  for (const group of groups) {
    const entries = commands.filter((command) => command.group === group);
    if (entries.length === 0) continue;
    lines.push(`\n── ${group} ──`);
    for (const command of entries) {
      const names = [command.name, ...(command.aliases ?? [])].join(", ");
      lines.push(`  ${names.padEnd(22)} - ${command.description}${command.usage ? ` (usage: ${command.usage})` : ""}`);
    }
  }
  lines.push("\nCommands run locally; they are never sent to the model.");
  return `${lines.join("\n")}\n`;
}
