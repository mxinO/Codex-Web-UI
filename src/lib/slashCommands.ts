const LOCAL_COMMANDS = new Set(['/help', '/status']);
const STATE_CHANGING_COMMANDS = new Set(['/new', '/resume', '/model', '/effort', '/mode', '/sandbox']);

export interface SlashCommandClassification {
  command: string;
  allowed: boolean;
  reason: string | null;
}

export interface ParsedSlashCommand {
  command: string;
  args: string[];
  value: string;
}

export function parseSlashCommand(input: string): ParsedSlashCommand {
  const parts = input.trim().split(/\s+/);
  const command = parts[0] ?? '';
  const args = parts.slice(1);
  return { command, args, value: args.join(' ') };
}

export function classifySlashCommand(input: string, turnActive: boolean): SlashCommandClassification {
  const { command } = parseSlashCommand(input);
  if (turnActive && STATE_CHANGING_COMMANDS.has(command)) {
    return { command, allowed: false, reason: `${command} is disabled while Codex is working` };
  }
  if (LOCAL_COMMANDS.has(command) || STATE_CHANGING_COMMANDS.has(command)) {
    return { command, allowed: true, reason: null };
  }
  return { command, allowed: false, reason: `${command} is not supported in the web UI` };
}
