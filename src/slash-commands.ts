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
