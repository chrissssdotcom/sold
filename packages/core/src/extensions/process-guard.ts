import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Attribution and process-level safety nets for extension code.
 *
 * Extensions are trusted in-process code (ADR-0004 documents the trust model), so a bug in one can surface
 * anywhere: a floating promise, a `setTimeout` callback that throws. Node's default is to exit the process on
 * both. That is right for a defect in Base, wrong for a defect in an extension: an extension bug must cost that
 * extension's feature, not the whole worker (and every other extension's jobs with it).
 *
 * The mechanism is an `AsyncLocalStorage` scope entered wherever Base calls extension code (interceptors,
 * observers, routes). Node propagates it into promises and timers created inside, so a rejection or an
 * uncaught exception can be traced back to the extension that started the work.
 */

export type ExtensionRunKind = 'interceptor' | 'observer' | 'route' | 'job' | 'lifecycle';

export interface ExtensionRunScope {
  extension: string;
  kind: ExtensionRunKind;
  /** Interceptor / observer / route / job name, when known. */
  name?: string;
}

const attribution = new AsyncLocalStorage<ExtensionRunScope>();

/** Run `fn` (and everything it starts) attributed to `scope.extension`. */
export function runAsExtension<T>(scope: ExtensionRunScope, fn: () => T): T {
  return attribution.run(scope, fn);
}

export function currentExtensionScope(): ExtensionRunScope | undefined {
  return attribution.getStore();
}

const EXTENSION_PATH = /[\\/]extensions[\\/]([a-z][a-z0-9-]{1,30})[\\/]/;

/**
 * Which extension does this failure belong to? Ordered from most to least reliable: the async scope it was
 * raised in; a `HotPathViolation` (which names its extension); a source path in the stack. A production bundle
 * rewrites paths, so the stack heuristic is a last resort and returns nothing rather than guess.
 */
export function attributeToExtension(reason: unknown): string | undefined {
  const scoped = attribution.getStore()?.extension;
  if (scoped) return scoped;
  if (reason && typeof reason === 'object') {
    const named = reason as { name?: unknown; extension?: unknown; stack?: unknown };
    if (named.name === 'HotPathViolation' && typeof named.extension === 'string')
      return named.extension;
    if (typeof named.stack === 'string') {
      const m = EXTENSION_PATH.exec(named.stack);
      if (m && m[1] !== '_template') return m[1];
    }
  }
  return undefined;
}

export interface UnhandledFailure {
  kind: 'unhandledRejection' | 'uncaughtException';
  /** The extension it was attributed to, if any. */
  extension?: string;
  error: unknown;
  /** True when the process is about to exit because nothing could be blamed. */
  fatal: boolean;
}

export interface ProcessGuardOptions {
  log(level: 'warn' | 'error', fields: Record<string, unknown>, message: string): void;
  /** Called for every failure (metrics). Must not throw. */
  onFailure?(failure: UnhandledFailure): void;
  /**
   * Exit (code 1) after logging when a failure cannot be attributed to an extension, exactly as Node would.
   * Default true. The web process (Next.js logs and continues) sets it false.
   */
  exitOnUnattributed?: boolean;
  /** Injectable for tests. */
  exit?(code: number): void;
}

/**
 * The two handlers, exposed so they can be tested without raising real process-level failures.
 * An extension-attributed failure is logged and counted and the process keeps running. Anything else is
 * logged and, by default, ends the process the way Node would have.
 */
export function createProcessGuardHandlers(opts: ProcessGuardOptions): {
  onUnhandledRejection(reason: unknown): void;
  onUncaughtException(error: Error): void;
} {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const handle = (kind: UnhandledFailure['kind'], error: unknown): void => {
    const extension = attributeToExtension(error);
    const scope = attribution.getStore();
    const fatal = extension === undefined && opts.exitOnUnattributed !== false;
    try {
      opts.log(
        'error',
        {
          kind,
          ...(extension ? { extension } : {}),
          ...(scope?.name ? { component: `${scope.kind}:${scope.name}` } : {}),
          err: error,
          ...(fatal ? { fatal: true } : {}),
        },
        extension
          ? 'unhandled failure in extension code contained (the process keeps running)'
          : 'unhandled failure outside any extension',
      );
      opts.onFailure?.({ kind, ...(extension ? { extension } : {}), error, fatal });
    } finally {
      // Never let logging trouble keep a process alive that Node would have ended.
      if (fatal) exit(1);
    }
  };
  return {
    onUnhandledRejection: (reason) => handle('unhandledRejection', reason),
    onUncaughtException: (error) => handle('uncaughtException', error),
  };
}

/** Install the handlers on `process`. Returns a function that removes them. Idempotent per call site. */
export function installProcessGuard(opts: ProcessGuardOptions): () => void {
  const h = createProcessGuardHandlers(opts);
  process.on('unhandledRejection', h.onUnhandledRejection);
  process.on('uncaughtException', h.onUncaughtException);
  return () => {
    process.off('unhandledRejection', h.onUnhandledRejection);
    process.off('uncaughtException', h.onUncaughtException);
  };
}
