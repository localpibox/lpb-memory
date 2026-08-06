/**
 * Error code map — maps child process exit codes to human-readable descriptions.
 * Extensible: add new codes as they're discovered.
 */

export interface ErrorDescription {
  title: string;
  hint?: string;
}

export const EXIT_CODE_MAP: Record<number, ErrorDescription> = {
  // Standard exit codes
  0: { title: "Success", hint: "Process completed normally" },
  1: { title: "General Error", hint: "Process exited with unknown error — check stderr for details" },
  2: { title: "Misuse of Shell Builtins", hint: "Bash syntax error or missing command" },
  126: { title: "Command Not Executable", hint: "Process exists but cannot be executed" },
  127: { title: "Command Not Found", hint: "The 'pi' CLI or a required binary was not found on PATH" },
  128: { title: "Invalid Exit Signal", hint: "Process was killed by an invalid signal" },
  130: { title: "Interrupted by Ctrl+C", hint: "Process was cancelled by user" },
  137: { title: "Killed (OOM)", hint: "Process exceeded memory limit and was killed (SIGKILL)" },
  139: { title: "Segmentation Fault", hint: "Process accessed invalid memory" },
  143: { title: "Terminated (SIGTERM)", hint: "Process was terminated by timeout watchdog" },
  247: { title: "Script Too Large", hint: "Process output exceeded buffer size" },
  255: { title: "Exit Status Out of Range", hint: "Invalid exit status value" },
};

/** Get a human-readable description for an exit code. Falls back to unknown if not mapped. */
export function describeExitCode(code: number): string {
  const desc = EXIT_CODE_MAP[code];
  if (!desc) {
    return `Unknown error (code=${code})`;
  }
  const msg = desc.title;
  return desc.hint ? `${msg} — ${desc.hint}` : msg;
}

/** Format a subprocess error result with full context. */
export function formatSubprocessError(
  code: number,
  stdout?: string,
  stderr?: string,
  command?: string,
): string {
  const title = describeExitCode(code);
  const lines = [`[${title}]`];
  if (command) {
    lines.push(`  Command: ${command}`);
  }
  if (stderr) {
    const trimmed = stderr.trim();
    if (trimmed) {
      const preview = trimmed.length > 500 ? trimmed.slice(0, 500) + "..." : trimmed;
      lines.push(`  stderr: ${preview.replace(/\n/g, " ")}`);
    }
  }
  if (stdout) {
    const trimmed = stdout.trim();
    if (trimmed) {
      const preview = trimmed.length > 500 ? trimmed.slice(0, 500) + "..." : trimmed;
      lines.push(`  stdout: ${preview.replace(/\n/g, " ")}`);
    }
  }
  return lines.join("\n");
}
