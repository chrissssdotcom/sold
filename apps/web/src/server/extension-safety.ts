import {
  installProcessGuard,
  onHotPathBlocked,
  type HotPathBlockedEvent,
  type UnhandledFailure,
} from '@sold/core/extensions';
import type { Logger } from '@sold/core/observability';
import type { ExtensionSafetyMetrics } from './metrics';

export interface ExtensionSafetyOptions {
  log: Pick<Logger, 'warn' | 'error'>;
  metrics: ExtensionSafetyMetrics;
  /**
   * What to do with a failure no extension can be blamed for. The worker exits after logging, as Node would (true).
   * The web process leaves that to Next.js, which already logs and continues (false).
   */
  exitOnUnattributed: boolean;
}

/**
 * Process-level containment for extension code, shared by the web process and the worker:
 *  - an unhandled rejection or uncaught exception raised by extension code is logged with the extension name,
 *    counted (`sold_extension_unhandled_failures_total`) and does NOT end the process;
 *  - one that cannot be attributed is logged and (worker) ends the process;
 *  - a hot-path interceptor that blocked the event loop past its budget is logged and recorded in
 *    `sold_extension_blocked_ms`. The runner additionally opens that interceptor's breaker past 5x its budget.
 * Returns an uninstall function (tests).
 */
export function installExtensionSafety(opts: ExtensionSafetyOptions): () => void {
  const offProcess = installProcessGuard({
    exitOnUnattributed: opts.exitOnUnattributed,
    log: (level, fields, message) => opts.log[level](fields, message),
    onFailure: (f: UnhandledFailure) =>
      opts.metrics.unhandled.inc({
        extension: f.extension ?? 'unattributed',
        kind: f.kind,
        fatal: String(f.fatal),
      }),
  });
  const offBlocked = onHotPathBlocked((e: HotPathBlockedEvent) => {
    opts.metrics.blocked.observe(
      { extension: e.extension, interceptor: e.interceptor, source: e.source },
      e.blockedMs,
    );
    opts.log.warn(
      { ...e },
      e.source === 'sync-call'
        ? 'interceptor blocked the event loop past its budget'
        : 'event loop stalled while this interceptor was the only one in flight (suspected)',
    );
  });
  return () => {
    offProcess();
    offBlocked();
  };
}
