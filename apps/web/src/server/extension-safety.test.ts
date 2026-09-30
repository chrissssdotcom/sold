import { reportHotPathBlocked, runAsExtension } from '@sold/core/extensions';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installExtensionSafety } from './extension-safety';
import { createExtensionSafetyMetrics } from './metrics';

describe('installExtensionSafety', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => uninstall?.());

  function setup(exitOnUnattributed: boolean) {
    const registry = new Registry();
    const log = { warn: vi.fn(), error: vi.fn() };
    const before = process.listeners('unhandledRejection');
    uninstall = installExtensionSafety({
      log,
      metrics: createExtensionSafetyMetrics(registry),
      exitOnUnattributed,
    });
    const added = process.listeners('unhandledRejection').filter((l) => !before.includes(l));
    // Vitest has its own handler: call ours directly instead of raising a real failure.
    return { registry, log, ours: added[0] as (reason: unknown) => void };
  }

  it('counts and logs an extension-attributed failure with the extension name; nothing exits', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { registry, log, ours } = setup(true);
    runAsExtension({ extension: 'careless', kind: 'observer', name: 'o' }, () =>
      ours(new Error('floating')),
    );
    expect(exit).not.toHaveBeenCalled();
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({ extension: 'careless' });
    const text = await registry.metrics();
    expect(text).toContain(
      'sold_extension_unhandled_failures_total{extension="careless",kind="unhandledRejection",fatal="false"} 1',
    );
    exit.mockRestore();
  });

  it('the web process (exitOnUnattributed:false) logs an unattributable failure and carries on', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { registry, ours } = setup(false);
    ours(new Error('next internal'));
    expect(exit).not.toHaveBeenCalled();
    expect(await registry.metrics()).toContain('extension="unattributed"');
    exit.mockRestore();
  });

  it('the worker (exitOnUnattributed:true) exits after logging an unattributable failure', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { log, ours } = setup(true);
    ours(new Error('base bug'));
    expect(log.error).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('records a blocked event loop in sold_extension_blocked_ms and warns', async () => {
    const { registry, log } = setup(false);
    reportHotPathBlocked({
      extension: 'stally',
      interceptor: 'spin',
      blockedMs: 120,
      budgetMs: 10,
      source: 'sync-call',
    });
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ extension: 'stally', blockedMs: 120 });
    const text = await registry.metrics();
    expect(text).toContain(
      'sold_extension_blocked_ms_count{extension="stally",interceptor="spin",source="sync-call"} 1',
    );
  });
});
