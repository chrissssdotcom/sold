import type { ProcessRunner } from '../lib/process';
import { formatCommand } from '../lib/process';
import { CliError } from '../lib/errors';

/** Thin, injectable wrapper over `git` so upgrade logic is tested against a real temp repository. */
export class Git {
  constructor(
    private readonly runner: ProcessRunner,
    readonly cwd: string,
    private readonly env: Record<string, string | undefined> = {},
  ) {}

  /** Runs git; throws CliError on failure unless `allowFailure`, in which case returns undefined. */
  async run(args: string[], options: { allowFailure?: boolean } = {}): Promise<string | undefined> {
    const result = await this.runner.run('git', args, { cwd: this.cwd, env: this.env });
    if (result.code !== 0) {
      if (options.allowFailure) return undefined;
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
      throw new CliError(
        `${formatCommand('git', args)} failed (exit ${result.code})${detail ? `:\n${detail}` : ''}`,
      );
    }
    return result.stdout;
  }

  async lines(
    args: string[],
    options: { allowFailure?: boolean } = {},
  ): Promise<string[] | undefined> {
    const out = await this.run(args, options);
    return out === undefined ? undefined : out.split('\n').filter((l) => l !== '');
  }

  async currentBranch(): Promise<string> {
    const out = (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])) ?? '';
    return out.trim();
  }

  async isClean(): Promise<boolean> {
    return ((await this.run(['status', '--porcelain'])) ?? '').trim() === '';
  }

  async dirtyFiles(): Promise<string[]> {
    return ((await this.lines(['status', '--porcelain'])) ?? []).map((l) => l.slice(3));
  }

  async refExists(ref: string): Promise<boolean> {
    return (
      (await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        allowFailure: true,
      })) !== undefined
    );
  }

  /** Files in a ref's tree, recursively, forward-slash paths. */
  async filesAt(ref: string): Promise<string[]> {
    return (
      (await this.lines(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', ref])) ?? []
    );
  }

  async trackedFiles(): Promise<string[]> {
    return (await this.lines(['-c', 'core.quotepath=false', 'ls-files'])) ?? [];
  }

  /** Contents of `path` at `ref`, or undefined if it does not exist there. */
  async show(ref: string, path: string): Promise<string | undefined> {
    return this.run(['show', `${ref}:${path}`], { allowFailure: true });
  }

  async tags(pattern: string): Promise<string[]> {
    return (await this.lines(['tag', '--list', pattern])) ?? [];
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
