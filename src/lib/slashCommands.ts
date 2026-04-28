export interface SlashCommandDefinition {
  command: string;
  description: string;
  valueHint?: string;
  stateChanging: boolean;
}

export interface SlashArgumentSuggestion {
  value: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { command: '/help', description: 'Show supported web UI commands', stateChanging: false },
  { command: '/status', description: 'Show current session, model, effort, mode, and sandbox', stateChanging: false },
  { command: '/new', description: 'Start a new session in a chosen working directory', stateChanging: true },
  { command: '/resume', description: 'Open the session picker', stateChanging: true },
  { command: '/model', description: 'Set the model used for new Codex turns', valueHint: '<name>', stateChanging: true },
  { command: '/effort', description: 'Set reasoning effort', valueHint: '<level>', stateChanging: true },
  { command: '/mode', description: 'Set collaboration mode', valueHint: '<default|plan>', stateChanging: true },
  { command: '/sandbox', description: 'Set sandbox mode', valueHint: '<mode>', stateChanging: true },
  { command: '/compact', description: 'Compact conversation when supported by Codex app-server', stateChanging: true },
  { command: '/diff', description: 'Show current worktree or thread diff when supported', stateChanging: false },
];

export const SLASH_ARGUMENT_SUGGESTIONS: Record<string, SlashArgumentSuggestion[]> = {
  '/effort': [
    { value: 'minimal', description: 'Smallest reasoning budget' },
    { value: 'low', description: 'Light reasoning' },
    { value: 'medium', description: 'Balanced reasoning' },
    { value: 'high', description: 'Deeper reasoning' },
    { value: 'xhigh', description: 'Maximum supported reasoning' },
  ],
  '/mode': [
    { value: 'default', description: 'Default collaboration mode' },
    { value: 'plan', description: 'Plan mode' },
  ],
  '/sandbox': [
    { value: 'read-only', description: 'Do not write files' },
    { value: 'workspace-write', description: 'Write inside the workspace' },
    { value: 'danger-full-access', description: 'No filesystem sandbox' },
  ],
};

const LOCAL_COMMANDS = new Set(SLASH_COMMANDS.filter((command) => !command.stateChanging).map((command) => command.command));
const STATE_CHANGING_COMMANDS = new Set(SLASH_COMMANDS.filter((command) => command.stateChanging).map((command) => command.command));

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
