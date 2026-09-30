/** Test doubles and fixtures shared by the unit tests. Not part of the package's public API. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemoryAzureInventory, InMemoryCloudflareInventory } from './env/fakes';
import { createBufferOutput, type CliContext } from './lib/context';
import { formatCommand, type ProcessRunner, type RunOptions, type RunResult } from './lib/process';

export type Matcher = string | RegExp | ((command: string, args: readonly string[]) => boolean);
export type Responder =
  RunResult | ((command: string, args: readonly string[], options?: RunOptions) => RunResult);

export interface RecordedCall {
  command: string;
  args: readonly string[];
  options: RunOptions | undefined;
  line: string;
}

/** Scripted process runner: records every call, answers from the first matching rule. */
export class FakeRunner implements ProcessRunner {
  calls: RecordedCall[] = [];
  private rules: { matcher: Matcher; responder: Responder; once: boolean; used: boolean }[] = [];

  on(
    matcher: Matcher,
    responder:
      Partial<RunResult> | ((c: string, a: readonly string[], o?: RunOptions) => RunResult),
    once = false,
  ): this {
    const full: Responder =
      typeof responder === 'function'
        ? responder
        : { code: 0, stdout: '', stderr: '', ...responder };
    this.rules.push({ matcher, responder: full, once, used: false });
    return this;
  }

  /** The scripted answer for a call, if any rule matches. */
  protected scripted(
    command: string,
    args: readonly string[],
    options?: RunOptions,
  ): RunResult | undefined {
    const line = formatCommand(command, args);
    for (const rule of this.rules) {
      if (rule.once && rule.used) continue;
      const m = rule.matcher;
      const hit =
        typeof m === 'string'
          ? line.includes(m)
          : m instanceof RegExp
            ? m.test(line)
            : m(command, args);
      if (hit) {
        rule.used = true;
        return typeof rule.responder === 'function'
          ? rule.responder(command, args, options)
          : rule.responder;
      }
    }
    return undefined;
  }

  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult> {
    this.calls.push({ command, args, options, line: formatCommand(command, args) });
    return Promise.resolve(
      this.scripted(command, args, options) ?? { code: 0, stdout: '', stderr: '' },
    );
  }

  lines(): string[] {
    return this.calls.map((c) => c.line);
  }

  find(fragment: string): RecordedCall | undefined {
    return this.calls.find((c) => c.line.includes(fragment));
  }
}

/** Runs `git` for real (fixtures use temporary repositories) and answers everything else from a fake. */
export class GitPassthroughRunner extends FakeRunner {
  override async run(
    command: string,
    args: readonly string[],
    options?: RunOptions,
  ): Promise<RunResult> {
    if (command !== 'git') return super.run(command, args, options);
    this.calls.push({ command, args, options, line: formatCommand(command, args) });
    const scripted = this.scripted(command, args, options);
    if (scripted) return scripted;
    try {
      const stdout = execFileSync('git', [...args], {
        cwd: options?.cwd,
        env: { ...process.env, ...gitIdentityEnv, ...options?.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }
}

export const gitIdentityEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export const FIXED_NOW = new Date('2026-09-30T12:00:00Z');

export interface TestContext extends CliContext {
  runner: FakeRunner;
  out: ReturnType<typeof createBufferOutput>;
  azure: InMemoryAzureInventory;
  cloudflare: InMemoryCloudflareInventory;
}

export function makeContext(overrides: Partial<CliContext> = {}): TestContext {
  const base: CliContext = {
    cwd: '/repo',
    env: {},
    runner: new FakeRunner(),
    out: createBufferOutput(),
    now: () => FIXED_NOW,
    sleep: () => Promise.resolve(),
    dryRun: false,
    azure: new InMemoryAzureInventory(),
    cloudflare: new InMemoryCloudflareInventory(),
    loadInstanceConfig: () => Promise.resolve({ customer: 'demo', tier: 'standard' }),
  };
  return { ...base, ...overrides } as TestContext;
}

export function tempDir(prefix = 'sold-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    env: { ...process.env, ...gitIdentityEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function initRepo(dir: string, branch = 'main'): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
}

export function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}
