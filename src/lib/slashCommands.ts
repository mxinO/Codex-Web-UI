const LOCAL_COMMANDS = new Set(['/help', '/status']);
const STATE_CHANGING_COMMANDS = new Set(['/new', '/resume', '/model', '/effort', '/mode', '/sandbox', '/compact', '/diff']);

export interface SlashCommandClassification {
  command: string;
  allowed: boolean;
  reason: string | null;
}

export function classifySlashCommand(input: string, turnActive: boolean): SlashCommandClassification {
  const command = input.trim().split(/\s+/, 1)[0];
  if (turnActive && STATE_CHANGING_COMMANDS.has(command)) {
    return { command, allowed: false, reason: `${command} is disabled while Codex is working` };
  }
  if (LOCAL_COMMANDS.has(command) || STATE_CHANGING_COMMANDS.has(command)) {
    return { command, allowed: true, reason: null };
  }
  return { command, allowed: false, reason: `${command} is not supported in the web UI` };
}
