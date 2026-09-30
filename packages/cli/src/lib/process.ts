import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Merged over the parent environment. Values are never printed by the CLI. */
  env?: Record<string, string | undefined>;
  /** Mirror child output to this process while still capturing it (long terraform runs). */
  stream?: boolean;
}

/**
 * The only way the CLI touches the outside world (terraform, az, git, pnpm). Injected everywhere so
 * command logic is unit-tested with a scripted fake and `--dry-run` can print instead of execute.
 */
export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** Spawns the real process. No shell: arguments are never interpreted, so values cannot inject commands. */
export class NodeProcessRunner implements ProcessRunner {
  run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (options.stream) process.stdout.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (options.stream) process.stderr.write(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
}

/** Shell-style rendering for logs and `--dry-run`. Display only: never executed. */
export function formatCommand(command: string, args: readonly string[]): string {
  const quote = (value: string): string =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
  return [command, ...args].map(quote).join(' ');
}
