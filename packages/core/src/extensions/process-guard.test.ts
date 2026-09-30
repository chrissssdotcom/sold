import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  attributeToExtension,
  createProcessGuardHandlers,
  currentExtensionScope,
  runAsExtension,
} from './process-guard';
import { HotPathViolation } from './hot-path-guard';

describe('attribution', () => {
  it('follows the async scope into promises and timers', async () => {
    const seen = await runAsExtension(
      { extension: 'loyalty-points', kind: 'observer' },
      async () => {
        await Promise.resolve();
        return new Promise<string | undefined>((r) =>
          setTimeout(() => r(currentExtensionScope()?.extension), 1),
        );
      },
    );
    expect(seen).toBe('loyalty-points');
    expect(currentExtensionScope()).toBeUndefined();
  });

  it('falls back to a HotPathViolation, then to an extension path in the stack, and never guesses', () => {
    expect(attributeToExtension(new HotPathViolation('shady', 'i', 'fetch()'))).toBe('shady');
    const fromStack = new Error('x');
    fromStack.stack = 'Error: x\n    at f (/srv/app/extensions/gift-cards/src/index.ts:10:5)';
    expect(attributeToExtension(fromStack)).toBe('gift-cards');
    const base = new Error('x');
    base.stack = 'Error: x\n    at f (/srv/app/packages/core/src/extensions/kernel.ts:10:5)';
    expect(attributeToExtension(base)).toBeUndefined();
    expect(attributeToExtension('a string')).toBeUndefined();
  });
});

describe('createProcessGuardHandlers', () => {
  it('contains an extension-attributed failure: logged with the extension, counted, no exit', () => {
    const exit = vi.fn();
    const log = vi.fn();
    const onFailure = vi.fn();
    const h = createProcessGuardHandlers({ log, onFailure, exit });
    runAsExtension({ extension: 'careless', kind: 'observer', name: 'o' }, () =>
      h.onUnhandledRejection(new Error('boom')),
    );
    runAsExtension({ extension: 'careless', kind: 'job' }, () =>
      h.onUncaughtException(new Error('boom')),
    );
    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      kind: 'unhandledRejection',
      extension: 'careless',
      component: 'observer:o',
    });
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'uncaughtException', extension: 'careless', fatal: false }),
    );
  });

  it('exits (after logging) for a failure nobody can be blamed for, like Node would', () => {
    const exit = vi.fn();
    const log = vi.fn();
    const h = createProcessGuardHandlers({ log, exit });
    h.onUnhandledRejection(new Error('base bug'));
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[1]).toMatchObject({ fatal: true });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exitOnUnattributed:false (web process) logs and continues', () => {
    const exit = vi.fn();
    const h = createProcessGuardHandlers({ log: vi.fn(), exit, exitOnUnattributed: false });
    h.onUncaughtException(new Error('next bug'));
    expect(exit).not.toHaveBeenCalled();
  });

  it('still exits when logging itself throws', () => {
    const exit = vi.fn();
    const h = createProcessGuardHandlers({
      log: () => {
        throw new Error('log down');
      },
      exit,
    });
    expect(() => h.onUncaughtException(new Error('x'))).toThrow('log down');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

/** Real Node behaviour, in a child process: vitest itself installs handlers, so it cannot show this in-process. */
function child(mode: string): Promise<{ code: number | null; out: Record<string, unknown>[] }> {
  const fixture = fileURLToPath(new URL('./process-guard.fixture.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', fixture, mode],
      { cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 30_000 },
      (error, stdout) => {
        const out = stdout
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ code: error ? (error.code as number) : 0, out });
      },
    );
  });
}

describe('process guard in a real process', () => {
  it.each([
    'observer-floating-rejection',
    'observer-timer-throw',
    'interceptor-floating-fetch',
    'scoped-throw',
  ])(
    '%s: the failure is attributed to the extension and the process survives',
    async (mode) => {
      const { code, out } = await child(mode);
      expect(code).toBe(0);
      expect(out).toContainEqual({ alive: true });
      const failure = out.find((o) => 'failure' in o) as {
        failure: { extension?: string; fatal: boolean };
      };
      expect(failure).toBeDefined();
      expect(failure.failure.fatal).toBe(false);
      expect(failure.failure.extension).toBe(
        {
          'observer-floating-rejection': 'careless',
          'observer-timer-throw': 'careless',
          'interceptor-floating-fetch': 'floaty',
          'scoped-throw': 'scoped',
        }[mode],
      );
    },
    40_000,
  );

  it.each(['unattributed-rejection', 'unattributed-throw'])(
    '%s: logged, then the process exits with code 1',
    async (mode) => {
      const { code, out } = await child(mode);
      expect(code).toBe(1);
      expect(out).toContainEqual({ log: { kind: expect.any(String), fatal: true } });
      expect(out).not.toContainEqual({ alive: true });
    },
    40_000,
  );
});
