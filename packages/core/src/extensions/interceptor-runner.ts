import type { HookMap, HookName, InterceptorContext, Veto } from '@sold/extension-sdk';
import {
  CircuitBreaker,
  CircuitOpenError,
  TimeoutError,
  withTimeout,
} from '../resilience/circuit-breaker';
import { SaturatedError, Semaphore } from '../resilience/semaphore';
import {
  HotPathViolation,
  beginHotPathCall,
  repairPrototypePollution,
  reportHotPathBlocked,
  runInHotPath,
} from './hot-path-guard';
import { hookModifySchemas } from './hook-schemas';
import type { LoadedExtension } from './load-order';

export type InterceptorOutcome =
  'ok' | 'veto' | 'error' | 'timeout' | 'violation' | 'saturated' | 'bypassed' | 'invalid-modify';

export interface InterceptorMetric {
  extension: string;
  interceptor: string;
  hook: HookName;
  outcome: InterceptorOutcome;
  durationMs: number;
  /** What the runner did about a non-ok outcome. */
  applied?: 'continued' | 'vetoed';
}

export interface RunnerOptions {
  extensions: readonly LoadedExtension[];
  /** Build the (I/O-free) context for an interceptor. */
  contextFor(extension: string, budgetMs: number, signal: AbortSignal): InterceptorContext;
  /** Global ceiling on interceptor calls in flight. Each extension additionally gets its own pool (below). */
  pool: Semaphore;
  /**
   * Per-extension concurrency: a slow extension can only ever occupy its own slots, so it cannot starve the
   * others of the global pool. Defaults: 8 in flight, 16 waiting.
   */
  perExtension?: { size?: number; queue?: number };
  /**
   * Longest a call may wait for a slot before failing fast as `saturated`. Waiting is never charged to the
   * interceptor's budget, but the shopper still waits, so it is bounded. Default: the interceptor's own budget.
   */
  maxQueueWaitMs?: number;
  onMetric?(metric: InterceptorMetric): void;
  onLog?(level: 'warn' | 'error', fields: Record<string, unknown>, message: string): void;
  breaker?: { failureThreshold?: number; cooldownMs?: number };
  now?: () => number;
}

interface Registered {
  extension: string;
  hook: HookName;
  name: string;
  failPolicy: 'open' | 'closed';
  timeoutMs: number;
  handler: (payload: unknown, ctx: InterceptorContext) => unknown;
  breaker: CircuitBreaker;
  sort: [number, number, string];
  pool: Semaphore;
}

/** A single call blocking the event loop for more than this multiple of its budget opens its breaker. */
export const BLOCKED_TRIP_FACTOR = 5;

/** The extension returned a `modify` that failed the hook's strict schema. Counts against its breaker. */
class InvalidModifyError extends Error {
  constructor() {
    super('interceptor returned an invalid modification');
    this.name = 'InvalidModifyError';
  }
}

interface CallResult {
  veto?: { code?: unknown; message?: unknown };
  modify?: unknown;
}

export interface InterceptResultOf<H extends HookName> {
  payload: HookMap[H]['payload'];
  veto: Veto | null;
}

const EXTENSION_UNAVAILABLE = (extension: string): Veto => ({
  code: 'extension_unavailable',
  message: `A required service is temporarily unavailable (${extension}). Please try again.`,
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

/**
 * Runs interceptors for a hook: sync from the caller's view, ordered, time-boxed, isolated.
 *
 * - Ordered by `order`, then extension load index, then name: deterministic.
 * - Each call has a deadline (declared timeout, capped by the extension budget) that starts when the handler
 *   starts, not while it queues. A late result is discarded even if it eventually arrives. The deadline cannot
 *   PREEMPT a synchronous loop (JavaScript cannot): a handler that blocks the event loop is detected after the
 *   fact, its result discarded, and past 5x its budget its breaker is opened (`sold_extension_blocked_ms`).
 * - A per-interceptor circuit breaker auto-bypasses a slow or failing extension. What "bypassed" means is the
 *   interceptor's declared `failPolicy`: `open` continues, `closed` vetoes. Only the extension's own faults
 *   count: our own pool being full, or the breaker already being open, never do.
 * - Concurrency is bounded per extension and globally; saturation fails fast, so one slow extension cannot
 *   starve another.
 * - Handlers get a frozen copy of the payload and an I/O-free context. The hot-path guard refuses new network
 *   connections and other I/O and records what it cannot refuse (see `hot-path-guard.ts`: a guardrail, not a
 *   sandbox; extensions are trusted code, ADR-0004).
 * - Everything an extension returns is read inside the guarded region and copied to plain data (a throwing getter
 *   or Proxy is just another extension error), then `modify` is validated against the hook's strict schema.
 * - No error ever escapes: an extension can never crash a request.
 */
export class InterceptorRunner {
  private readonly byHook = new Map<HookName, Registered[]>();
  private readonly pools = new Map<string, Semaphore>();
  private readonly opts: RunnerOptions;
  private readonly now: () => number;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => performance.now());
    for (const loaded of opts.extensions) {
      const { manifest } = loaded;
      for (const i of manifest.interceptors) {
        const timeoutMs = Math.min(
          i.timeoutMs ?? manifest.performance.budgetMs,
          manifest.performance.budgetMs,
        );
        const entry: Registered = {
          extension: manifest.name,
          hook: i.hook,
          name: i.name,
          failPolicy: i.failPolicy,
          timeoutMs,
          handler: i.handler as unknown as Registered['handler'],
          breaker: new CircuitBreaker({
            name: `${manifest.name}/${i.name}`,
            failureThreshold: opts.breaker?.failureThreshold ?? 5,
            cooldownMs: opts.breaker?.cooldownMs ?? 10_000,
            // Overload of our own pool is not evidence that the extension is unhealthy.
            ignoreError: (e) => e instanceof SaturatedError || e instanceof CircuitOpenError,
            ...(opts.now ? { now: opts.now } : {}),
          }),
          sort: [i.order ?? 100, loaded.index, i.name],
          pool: this.poolFor(manifest.name),
        };
        const list = this.byHook.get(i.hook) ?? [];
        list.push(entry);
        this.byHook.set(i.hook, list);
      }
    }
    for (const list of this.byHook.values()) {
      list.sort(
        (a, b) =>
          a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2].localeCompare(b.sort[2]),
      );
    }
  }

  private poolFor(extension: string): Semaphore {
    let pool = this.pools.get(extension);
    if (!pool) {
      pool = new Semaphore(
        `interceptors/${extension}`,
        this.opts.perExtension?.size ?? 8,
        this.opts.perExtension?.queue ?? 16,
      );
      this.pools.set(extension, pool);
    }
    return pool;
  }

  has(hook: HookName): boolean {
    return (this.byHook.get(hook)?.length ?? 0) > 0;
  }

  async run<H extends HookName>(
    hook: H,
    input: HookMap[H]['payload'],
  ): Promise<InterceptResultOf<H>> {
    let payload = input;
    for (const reg of this.byHook.get(hook) ?? []) {
      const started = this.now();
      const controller = new AbortController();
      let outcome: InterceptorOutcome = 'ok';
      let result: { veto?: Veto; modify?: unknown } = {};
      try {
        result = await reg.breaker.exec(() => this.invoke(reg, hook, payload, controller, started));
      } catch (error) {
        controller.abort();
        outcome = classify(error);
        this.opts.onLog?.(
          outcome === 'bypassed' ? 'warn' : 'error',
          {
            extension: reg.extension,
            interceptor: reg.name,
            hook,
            outcome,
            err: error instanceof Error ? error.message : String(error),
          },
          outcome === 'invalid-modify'
            ? 'interceptor returned an invalid modification'
            : 'interceptor did not complete',
        );
      }

      if (outcome === 'ok') {
        if (result.veto) {
          this.metric(reg, 'veto', started);
          return { payload, veto: result.veto };
        }
        if (result.modify !== undefined)
          payload = { ...payload, ...(result.modify as object) } as HookMap[H]['payload'];
        this.metric(reg, outcome, started);
        continue;
      }

      const applied = reg.failPolicy === 'closed' ? 'vetoed' : 'continued';
      this.metric(reg, outcome, started, applied);
      if (applied === 'vetoed') return { payload, veto: EXTENSION_UNAVAILABLE(reg.extension) };
    }
    return { payload, veto: null };
  }

  /**
   * One guarded call. Runs inside the breaker, so everything that can go wrong with the extension, including
   * reading what it returned, is counted against it and cannot escape as an unhandled error.
   */
  private async invoke<H extends HookName>(
    reg: Registered,
    hook: H,
    payload: HookMap[H]['payload'],
    controller: AbortController,
    started: number,
  ): Promise<{ veto?: Veto; modify?: unknown }> {
    // Waiting for a slot is bounded, and is not charged to the interceptor's budget (the clock starts below).
    const maxWait = this.opts.maxQueueWaitMs ?? reg.timeoutMs;
    const releaseExtension = await reg.pool.acquire(maxWait);
    let releaseGlobal: () => void;
    try {
      releaseGlobal = await this.opts.pool.acquire(Math.max(0, maxWait - (this.now() - started)));
    } catch (error) {
      releaseExtension();
      throw error;
    }
    const call = beginHotPathCall({
      extension: reg.extension,
      interceptor: reg.name,
      budgetMs: reg.timeoutMs,
    });
    let failure: { error: unknown } | undefined;
    let value: { veto?: Veto; modify?: unknown } = {};
    try {
      value = await this.callHandler(reg, hook, payload, controller, call);
    } catch (error) {
      failure = { error };
    } finally {
      call.end();
      releaseGlobal();
      releaseExtension();
    }
    // Objects the handler added to the built-in prototypes would poison every other request: remove and report.
    const polluted = repairPrototypePollution();
    if (polluted.length > 0)
      throw new HotPathViolation(reg.extension, reg.name, `modifying ${polluted.join(', ')}`);
    if (failure) throw failure.error;
    return value;
  }

  private async callHandler<H extends HookName>(
    reg: Registered,
    hook: H,
    payload: HookMap[H]['payload'],
    controller: AbortController,
    call: { markReported(): void },
  ): Promise<{ veto?: Veto; modify?: unknown }> {
    const input = deepFreeze(structuredClone(payload));
    const ctx = this.opts.contextFor(reg.extension, reg.timeoutMs, controller.signal);
    const handlerStarted = this.now();
    const guarded = runInHotPath({ extension: reg.extension, interceptor: reg.name }, () =>
      reg.handler(input, ctx),
    );
    // How long the handler held the event loop before its first `await`. Exact, and the only stall that can be
    // attributed with certainty. It cannot be preempted, so this is detection: discard, report, and cut it off.
    const syncMs = this.now() - handlerStarted;
    if (syncMs > reg.timeoutMs) {
      call.markReported();
      reportHotPathBlocked({
        extension: reg.extension,
        interceptor: reg.name,
        blockedMs: Math.round(syncMs),
        budgetMs: reg.timeoutMs,
        source: 'sync-call',
      });
      if (syncMs > reg.timeoutMs * BLOCKED_TRIP_FACTOR) reg.breaker.trip();
    }
    const remaining = reg.timeoutMs - syncMs;
    if (remaining <= 0) {
      Promise.resolve(guarded.value).catch(() => undefined); // its late failure is ours to swallow
      throw new TimeoutError(`${reg.extension}/${reg.name}`, reg.timeoutMs);
    }
    const raw = (await withTimeout(
      Promise.resolve(guarded.value),
      remaining,
      `${reg.extension}/${reg.name}`,
    )) as CallResult | undefined;
    // A synchronous busy-loop after an `await` cannot be preempted either; discard a result that arrived late.
    if (this.now() - handlerStarted > reg.timeoutMs)
      throw new TimeoutError(`${reg.extension}/${reg.name}`, reg.timeoutMs);
    const [first] = guarded.violations;
    if (first) throw new HotPathViolation(reg.extension, reg.name, first);
    return this.readResult(reg, hook, raw);
  }

  /** Copy what the handler returned into plain data. Any getter/Proxy trap that throws throws here, inside the breaker. */
  private readResult<H extends HookName>(
    reg: Registered,
    hook: H,
    raw: CallResult | undefined,
  ): { veto?: Veto; modify?: unknown } {
    if (raw === undefined || raw === null || typeof raw !== 'object') return {};
    const veto = raw.veto;
    if (veto) {
      const v = veto as { code?: unknown; message?: unknown };
      return { veto: sanitizeVeto(v, reg.extension) };
    }
    const modify = raw.modify;
    if (modify === undefined) return {};
    const parsed = hookModifySchemas[hook].safeParse(structuredClone(modify));
    if (!parsed.success) throw new InvalidModifyError();
    return { modify: parsed.data };
  }

  private metric(
    reg: Registered,
    outcome: InterceptorOutcome,
    started: number,
    applied?: 'continued' | 'vetoed',
  ): void {
    this.opts.onMetric?.({
      extension: reg.extension,
      interceptor: reg.name,
      hook: reg.hook,
      outcome,
      durationMs: Math.round((this.now() - started) * 100) / 100,
      ...(applied ? { applied } : {}),
    });
  }
}

function classify(error: unknown): InterceptorOutcome {
  if (error instanceof CircuitOpenError) return 'bypassed';
  if (error instanceof InvalidModifyError) return 'invalid-modify';
  if (error instanceof TimeoutError) return 'timeout';
  if (error instanceof HotPathViolation) return 'violation';
  if (error instanceof SaturatedError) return 'saturated';
  return 'error';
}

const MAX_VETO_MESSAGE = 200;

/**
 * Vetoes come from third-party code and are shown to shoppers: bound their size and shape. Control characters
 * and bidirectional/invisible formatting characters are removed (they can reorder or hide text), and `<` `>`
 * are dropped so the message stays inert wherever a client renders it. Length is counted in code points.
 */
export function sanitizeVeto(veto: { code?: unknown; message?: unknown }, extension: string): Veto {
  const code =
    typeof veto.code === 'string' && /^[a-z0-9_.-]{1,64}$/.test(veto.code) ? veto.code : 'vetoed';
  const cleaned =
    typeof veto.message === 'string'
      ? veto.message
          .replaceAll(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
          .replaceAll(/[\p{Cf}<>]/gu, '')
          .replaceAll(/\s+/g, ' ')
          .trim()
      : '';
  const message =
    cleaned === ''
      ? `Not allowed (${extension}).`
      : [...cleaned].slice(0, MAX_VETO_MESSAGE).join('');
  return { code, message };
}
