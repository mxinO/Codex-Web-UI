const INTERACTIVE_COMMAND_PATTERN =
  /(^|[;&|]\s*)(?:\S+\/)?(?:vi|vim|nano|emacs|less|more|top|htop|ssh|sftp|ftp|python(?:\d+(?:\.\d+)?)?|node|bash|zsh|fish)(?:\s|$)/i;

export interface BangCommandParams {
  command: ['bash', '-lc', string];
  cwd: string;
  timeoutMs: number;
  outputBytesCap: number;
  tty: false;
  streamStdoutStderr: false;
  streamStdin: false;
}

export function isInteractiveCommandBlocked(command: string): boolean {
  return INTERACTIVE_COMMAND_PATTERN.test(command.trim());
}

export function buildBangCommandParams(command: string, cwd: string, timeoutMs: number, outputBytesCap: number): BangCommandParams {
  return {
    command: ['bash', '-lc', command],
    cwd,
    timeoutMs,
    outputBytesCap,
    tty: false,
    streamStdoutStderr: false,
    streamStdin: false,
  };
}
