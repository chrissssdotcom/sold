import { AsyncLocalStorage } from 'node:async_hooks';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import module from 'node:module';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import workerThreads from 'node:worker_threads';
import { runAsExtension } from './process-guard';

/**
 * A best-effort GUARDRAIL for the hot-path contract (Section 8A.8), not a sandbox.
 *
 * Extensions are trusted, in-process code (ADR-0004). The contract for cart and checkout interceptors is "no
 * I/O, a small time budget, a declared failPolicy". What Base actually does to keep it:
 *
 *   Prevents (throws `HotPathViolation`, safe because nothing shared is touched):
 *     opening a connection (`net.Socket#connect`), global `fetch`, UDP sends, DNS lookups, spawning a process or
 *     a worker thread, and `Atomics.wait`, while an interceptor runs.
 *   Detects and reports (the call is failed afterwards, but the operation itself happened):
 *     a write to an already-open socket (a pooled keep-alive connection, a warm pg/redis pool). Throwing from
 *     inside such a write would corrupt a connection shared with Base, so it is recorded on the call instead.
 *     Also: mutation of `Object.prototype`/`Array.prototype` (repaired), and a synchronous stall of the event loop.
 *   Cannot stop, and does not claim to:
 *     a captured pre-guard `fetch`/socket on a fresh tick, `fs` access, any CPU loop (a synchronous loop cannot be
 *     preempted: the budget only discards the late result and, past 5x, trips the circuit breaker), anything
 *     done from another thread, or native addons. Real isolation would need a separate process or worker.
 *
 * The primary controls are upstream: the interceptor context has no I/O clients, and the extension lint rule keeps
 * network, fs and process modules out of interceptor files (`*.interceptor.ts`).
 */
export class HotPathViolation extends Error {
  constructor(
    public readonly extension: string,
    public readonly interceptor: string,
    public readonly operation: string,
  ) {
    super(
      `Extension "${extension}" interceptor "${interceptor}" attempted ${operation} on the cart/checkout hot path`,
    );
    this.name = 'HotPathViolation';
  }
}

interface Scope {
  extension: string;
  interceptor: string;
  /** Operations the guard saw but could not safely block. The runner fails the call if any are present. */
  violations: string[];
}

const storage = new AsyncLocalStorage<Scope>();

export function currentHotPathScope(): { extension: string; interceptor: string } | undefined {
  return storage.getStore();
}

/**
 * Run `fn` as an interceptor: attributed to the extension, with the guard active. Also returns what the guard
 * recorded but could not block (see the header), so the runner can fail the call afterwards.
 */
export function runInHotPath<T>(
  scope: { extension: string; interceptor: string },
  fn: () => T,
): { value: T; violations: string[] } {
  const full: Scope = { ...scope, violations: [] };
  const value = runAsExtension(
    { extension: scope.extension, kind: 'interceptor', name: scope.interceptor },
    () => storage.run(full, fn),
  );
  return { value, violations: full.violations };
}

function block(scope: Scope, operation: string): never {
  scope.violations.push(operation);
  throw new HotPathViolation(scope.extension, scope.interceptor, operation);
}

// ---------------------------------------------------------------------------------------------------------
// Blocked-event-loop detection (detection, not prevention)
// ---------------------------------------------------------------------------------------------------------

export interface HotPathBlockedEvent {
  extension: string;
  interceptor: string;
  /** How long the event loop was held. */
  blockedMs: number;
  /** The interceptor's budget the stall exceeded. */
  budgetMs: number;
  /**
   * `sync-call`: measured exactly around the handler's synchronous part (trusted; trips the breaker past 5x).
   * `event-loop-lag`: a timer arrived late while this was the only interceptor in flight (a suspicion, since
   * anything else on the loop could have caused it: recorded, never used to trip a breaker).
   */
  source: 'sync-call' | 'event-loop-lag';
}

type BlockedListener = (event: HotPathBlockedEvent) => void;
const blockedListeners = new Set<BlockedListener>();

/** Subscribe to blocked-event-loop reports (metrics, logs, breakers). Returns the unsubscribe function. */
export function onHotPathBlocked(listener: BlockedListener): () => void {
  blockedListeners.add(listener);
  return () => void blockedListeners.delete(listener);
}

export function reportHotPathBlocked(event: HotPathBlockedEvent): void {
  for (const l of [...blockedListeners]) {
    try {
      l(event);
    } catch {
      // A listener must never affect the request.
    }
  }
}

interface CallRecord {
  extension: string;
  interceptor: string;
  budgetMs: number;
  startedAt: number;
  endedAt?: number;
  reportedAt?: number;
}
const inFlight = new Set<CallRecord>();
let recentlyEnded: CallRecord[] = [];

export interface HotPathCall {
  /** Mark that an exact stall report was already made for this call, so the lag monitor does not repeat it. */
  markReported(): void;
  end(): void;
}

/** The runner announces each interceptor call so a stalled event loop can be attributed. */
export function beginHotPathCall(info: {
  extension: string;
  interceptor: string;
  budgetMs: number;
}): HotPathCall {
  const record: CallRecord = { ...info, startedAt: performance.now() };
  inFlight.add(record);
  return {
    markReported: () => {
      record.reportedAt = performance.now();
    },
    end: () => {
      record.endedAt = performance.now();
      inFlight.delete(record);
      recentlyEnded.push(record);
    },
  };
}

export interface EventLoopMonitorOptions {
  /** Timer period. Default 10ms. */
  intervalMs?: number;
  /** Ignore lateness below this. Default 15ms. */
  minStallMs?: number;
}

/** Timer-drift monitor. The timer is unref'd, so it never keeps a process alive. Returns the stop function. */
export function startEventLoopMonitor(opts: EventLoopMonitorOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 10;
  const minStallMs = opts.minStallMs ?? 15;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - last - intervalMs;
    if (late >= minStallMs) {
      const candidates = [...inFlight, ...recentlyEnded].filter(
        (c) =>
          (c.endedAt ?? now) >= last &&
          c.startedAt <= now &&
          !(c.reportedAt && c.reportedAt >= last),
      );
      const only = candidates.length === 1 ? candidates[0] : undefined;
      if (only && late > only.budgetMs)
        reportHotPathBlocked({
          extension: only.extension,
          interceptor: only.interceptor,
          blockedMs: Math.round(late),
          budgetMs: only.budgetMs,
          source: 'event-loop-lag',
        });
    }
    recentlyEnded = [];
    last = now;
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------------------------------------
// Prototype pollution
// ---------------------------------------------------------------------------------------------------------

const protoTargets: [string, object][] = [
  ['Object.prototype', Object.prototype],
  ['Array.prototype', Array.prototype],
];
let protoBaseline: Map<object, Set<string | symbol>> | null = null;

const keysOf = (o: object): (string | symbol)[] => Reflect.ownKeys(o);

/**
 * Remove properties added to the built-in prototypes since the guard was installed and return their names.
 * A cheap check (a few dozen keys) run after each interceptor call. Only additions are handled; redefining an
 * existing method is not detected.
 */
export function repairPrototypePollution(): string[] {
  if (!protoBaseline) return [];
  const added: string[] = [];
  for (const [label, target] of protoTargets) {
    const base = protoBaseline.get(target);
    if (!base) continue;
    for (const key of keysOf(target)) {
      if (base.has(key)) continue;
      added.push(`${label}.${String(key)}`);
      try {
        Reflect.deleteProperty(target, key);
      } catch {
        // Non-configurable additions cannot be removed; they are still reported.
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------------------

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
let restores: (() => void)[] | null = null;

/** Replace `target[key]` with a wrapper that runs `check(scope)` first while an interceptor is running. */
function wrap(
  target: object,
  key: string,
  check: (scope: Scope) => void,
  undo: (() => void)[],
): void {
  const original = (target as Record<string, unknown>)[key];
  if (typeof original !== 'function') return;
  const guarded = function guarded(this: unknown, ...args: unknown[]) {
    const scope = storage.getStore();
    if (scope) check(scope);
    return (original as AnyFn).apply(this, args);
  };
  // Keep helper properties such as `util.promisify.custom`, so promisify(dns.lookup) still works.
  Object.defineProperties(guarded, Object.getOwnPropertyDescriptors(original));
  (target as Record<string, unknown>)[key] = guarded;
  undo.push(() => {
    (target as Record<string, unknown>)[key] = original;
  });
}

export interface InstallOptions {
  /** Start the timer-drift monitor (default true). */
  monitor?: boolean | EventLoopMonitorOptions;
}

/** Idempotent. Call once at boot in any process that runs interceptors. */
export function installHotPathGuard(opts: InstallOptions = {}): void {
  if (restores) return;
  const undo: (() => void)[] = [];
  restores = undo;

  // Opening a connection: safe to refuse (nothing exists yet).
  wrap(net.Socket.prototype, 'connect', (s) => block(s, 'a network connection'), undo);
  wrap(dgram.Socket.prototype, 'send', (s) => block(s, 'a UDP send'), undo);
  wrap(dgram.Socket.prototype, 'connect', (s) => block(s, 'a UDP connection'), undo);
  for (const fn of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6'] as const)
    wrap(dns, fn, (s) => block(s, `a DNS ${fn}`), undo);
  for (const fn of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork'])
    wrap(childProcess, fn, (s) => block(s, 'spawning a process'), undo);
  const OriginalWorker = workerThreads.Worker;
  (workerThreads as { Worker: unknown }).Worker = new Proxy(OriginalWorker, {
    construct(target, args, newTarget) {
      const scope = storage.getStore();
      if (scope) block(scope, 'starting a worker thread');
      return Reflect.construct(target, args, newTarget);
    },
  });
  undo.push(() => {
    (workerThreads as { Worker: unknown }).Worker = OriginalWorker;
  });
  wrap(Atomics, 'wait', (s) => block(s, 'Atomics.wait (blocks the thread)'), undo);

  // Writing to an open socket: NOT safe to refuse. A pooled pg/redis/undici connection is shared with Base, and
  // an exception thrown from inside its write path leaves it wedged. Record it; the runner fails the call.
  const originalWrite = net.Socket.prototype.write;
  net.Socket.prototype.write = function guardedWrite(this: net.Socket, ...args: unknown[]) {
    const scope = storage.getStore();
    if (scope && this !== process.stdout && this !== process.stderr)
      scope.violations.push('a write to an open network socket');
    return (originalWrite as unknown as AnyFn).apply(this, args);
  } as typeof net.Socket.prototype.write;
  undo.push(() => {
    net.Socket.prototype.write = originalWrite;
  });

  const originalFetch = globalThis.fetch;
  if (originalFetch) {
    globalThis.fetch = function guardedFetch(...args: Parameters<typeof fetch>) {
      const scope = storage.getStore();
      if (scope) {
        scope.violations.push('fetch()');
        return Promise.reject(new HotPathViolation(scope.extension, scope.interceptor, 'fetch()'));
      }
      return originalFetch(...args);
    } as typeof fetch;
    undo.push(() => {
      globalThis.fetch = originalFetch;
    });
  }

  protoBaseline = new Map(protoTargets.map(([, t]) => [t, new Set(keysOf(t))]));
  undo.push(() => {
    protoBaseline = null;
  });

  if (opts.monitor !== false)
    undo.push(startEventLoopMonitor(typeof opts.monitor === 'object' ? opts.monitor : {}));

  module.syncBuiltinESMExports();
}

export function uninstallHotPathGuard(): void {
  if (!restores) return;
  for (const undo of restores.reverse()) undo();
  restores = null;
  module.syncBuiltinESMExports();
}
