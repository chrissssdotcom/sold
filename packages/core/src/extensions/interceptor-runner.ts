import type { HookMap, HookName, InterceptorContext, Veto } from '@sold/extension-sdk';
import {
  CircuitBreaker,
  CircuitOpenError,
  TimeoutError,
  withTimeout,
} from '../resilience/circuit-breaker';
import { SaturatedError, type Semaphore } from '../resilience/semaphore';
import { HotPathViolation, runInHotPath } from './hot-path-guard';
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
  pool: Semaphore;
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
 * - Each call has a hard deadline (declared timeout, capped by the extension budget). A late result is
 *   discarded even if it eventually arrives.
 * - A per-interceptor circuit breaker auto-bypasses a slow or failing extension. What "bypassed" means is
 *   the interceptor's declared `failPolicy`: `open` continues, `closed` vetoes.
 * - Concurrency is bounded by a shared pool; saturation fails fast.
 * - Handlers get a frozen copy of the payload and an I/O-free context; network use throws `HotPathViolation`.
 * - `modify` results are validated against the hook's strict schema before being applied.
 * - No error ever escapes: an extension can never crash a request.
 */
export class InterceptorRunner {
  private readonly byHook = new Map<HookName, Registered[]>();
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
            ...(opts.now ? { now: opts.now } : {}),
          }),
          sort: [i.order ?? 100, loaded.index, i.name],
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
      let result: { modify?: unknown; veto?: Veto } | undefined;
      try {
        result = (await reg.breaker.exec(() =>
          this.opts.pool.run(() =>
            withTimeout(
              runInHotPath({ extension: reg.extension, interceptor: reg.name }, async () =>
                reg.handler(
                  deepFreeze(structuredClone(payload)),
                  this.opts.contextFor(reg.extension, reg.timeoutMs, controller.signal),
                ),
              ),
              reg.timeoutMs,
              `${reg.extension}/${reg.name}`,
            ),
          ),
        )) as { modify?: unknown; veto?: Veto } | undefined;
        // A synchronous busy-loop cannot be preempted; discard results that arrived past the deadline.
        if (this.now() - started > reg.timeoutMs)
          throw new TimeoutError(`${reg.extension}/${reg.name}`, reg.timeoutMs);
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
          'interceptor did not complete',
        );
        result = undefined;
      }

      if (outcome === 'ok' && result && typeof result === 'object') {
        if (result.veto) {
          outcome = 'veto';
          this.metric(reg, outcome, started);
          return { payload, veto: sanitizeVeto(result.veto, reg.extension) };
        }
        if (result.modify !== undefined) {
          const parsed = hookModifySchemas[hook].safeParse(result.modify);
          if (parsed.success)
            payload = { ...payload, ...(parsed.data as object) } as HookMap[H]['payload'];
          else {
            outcome = 'invalid-modify';
            this.opts.onLog?.(
              'error',
              { extension: reg.extension, interceptor: reg.name, hook },
              'interceptor returned an invalid modification',
            );
          }
        }
      }

      if (outcome !== 'ok') {
        const applied = reg.failPolicy === 'closed' ? 'vetoed' : 'continued';
        this.metric(reg, outcome, started, applied);
        if (applied === 'vetoed') return { payload, veto: EXTENSION_UNAVAILABLE(reg.extension) };
        continue;
      }
      this.metric(reg, outcome, started);
    }
    return { payload, veto: null };
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
  if (error instanceof TimeoutError) return 'timeout';
  if (error instanceof HotPathViolation) return 'violation';
  if (error instanceof SaturatedError) return 'saturated';
  return 'error';
}

/** Vetoes come from third-party code and are shown to shoppers: bound their size and shape. */
function sanitizeVeto(veto: Veto, extension: string): Veto {
  const code =
    typeof veto.code === 'string' && /^[a-z0-9_.-]{1,64}$/.test(veto.code) ? veto.code : 'vetoed';
  const message =
    typeof veto.message === 'string' && veto.message.trim()
      ? veto.message.slice(0, 200)
      : `Not allowed (${extension}).`;
  return { code, message };
}
