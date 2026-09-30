import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  defineExtension,
  type InterceptorContext,
  type InterceptorDefinition,
} from '@sold/extension-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Semaphore } from '../resilience/semaphore';
import { installHotPathGuard, uninstallHotPathGuard } from './hot-path-guard';
import { InterceptorRunner, type InterceptorMetric } from './interceptor-runner';
import type { LoadedExtension } from './load-order';

beforeAll(() => installHotPathGuard());
afterAll(() => uninstallHotPathGuard());

type CartInterceptor = InterceptorDefinition<'cart.item.adding', InterceptorContext>;
const payload = { cartId: 'c1', variantId: 'v1', quantity: 5 };

function loaded(
  name: string,
  index: number,
  interceptors: Partial<CartInterceptor>[],
  budgetMs = 20,
): LoadedExtension {
  const manifest = defineExtension({
    name,
    version: '1.0.0',
    requires: { base: '*' },
    performance: { hotPath: true, budgetMs },
    interceptors: interceptors.map((i, n) => ({
      hook: 'cart.item.adding' as const,
      name: `i${n}`,
      failPolicy: 'open' as const,
      handler: () => undefined,
      ...i,
    })),
  });
  return { manifest, origin: 'instance', index };
}

function runner(
  extensions: LoadedExtension[],
  over: { pool?: Semaphore; breaker?: { failureThreshold?: number; cooldownMs?: number } } = {},
) {
  const metrics: InterceptorMetric[] = [];
  const logs: { level: string; fields: Record<string, unknown> }[] = [];
  const r = new InterceptorRunner({
    extensions,
    contextFor: (extension, budgetMs, signal) => ({
      extension,
      budgetMs,
      signal,
      log: noopLog,
      settings: { get: async () => ({}) },
    }),
    pool: over.pool ?? new Semaphore('test', 8, 8),
    onMetric: (m) => metrics.push(m),
    onLog: (level, fields) => logs.push({ level, fields }),
    ...(over.breaker ? { breaker: over.breaker } : {}),
  });
  return { r, metrics, logs };
}
const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

describe('InterceptorRunner', () => {
  it('passes through with no interceptors', async () => {
    const { r } = runner([]);
    expect(await r.run('cart.item.adding', payload)).toEqual({ payload, veto: null });
  });

  it('applies validated modifications in order and vetoes stop the chain', async () => {
    const seen: number[] = [];
    const { r } = runner([
      loaded('cap-qty', 0, [
        { order: 20, handler: (p) => (seen.push(p.quantity), { modify: { quantity: 3 } }) },
      ]),
      loaded('double', 1, [
        {
          order: 10,
          handler: (p) => (seen.push(p.quantity), { modify: { quantity: p.quantity * 2 } }),
        },
      ]),
    ]);
    const out = await r.run('cart.item.adding', payload);
    expect(seen).toEqual([5, 10]); // 'double' (order 10) runs before 'cap-qty' (order 20)
    expect(out.payload.quantity).toBe(3);
    expect(out.veto).toBeNull();

    const { r: r2, metrics } = runner([
      loaded('limit', 0, [
        {
          order: 1,
          handler: () => ({ veto: { code: 'max_per_customer', message: 'Limit 2 per customer' } }),
        },
      ]),
      loaded('never', 1, [
        {
          order: 2,
          handler: () => {
            throw new Error('must not run');
          },
        },
      ]),
    ]);
    const vetoed = await r2.run('cart.item.adding', payload);
    expect(vetoed.veto).toEqual({ code: 'max_per_customer', message: 'Limit 2 per customer' });
    expect(metrics.map((m) => m.outcome)).toEqual(['veto']);
  });

  it('breaks ties by extension load order, then name', async () => {
    const order: string[] = [];
    const h = (n: string): Partial<CartInterceptor> => ({ handler: () => void order.push(n) });
    const { r } = runner([loaded('zed', 0, [h('zed')]), loaded('alpha', 1, [h('alpha')])]);
    await r.run('cart.item.adding', payload);
    expect(order).toEqual(['zed', 'alpha']);
  });

  it('gives handlers a frozen copy: they cannot mutate the payload', async () => {
    const { r, metrics } = runner([
      loaded('mutator', 0, [
        {
          handler: (p) => {
            (p as { quantity: number }).quantity = 999;
          },
        },
      ]),
    ]);
    const out = await r.run('cart.item.adding', payload);
    expect(out.payload.quantity).toBe(5);
    expect(payload.quantity).toBe(5);
    expect(metrics[0]?.outcome).toBe('error');
  });

  it('rejects modifications that fail the hook schema', async () => {
    const { r, metrics } = runner([
      loaded('bad', 0, [{ handler: () => ({ modify: { quantity: -5 } }) }]),
      loaded('sneaky', 1, [
        { handler: () => ({ modify: { cartId: 'other', quantity: 2 } as never }) },
      ]),
    ]);
    const out = await r.run('cart.item.adding', payload);
    expect(out.payload).toEqual(payload);
    expect(metrics.map((m) => m.outcome)).toEqual(['invalid-modify', 'invalid-modify']);
  });

  it('isolates errors: fail-open continues, fail-closed vetoes; nothing throws', async () => {
    const boom: Partial<CartInterceptor> = {
      handler: () => {
        throw new Error('secret db password');
      },
    };
    const open = runner([loaded('flaky', 0, [{ ...boom, failPolicy: 'open' }])]);
    expect((await open.r.run('cart.item.adding', payload)).veto).toBeNull();
    const closed = runner([loaded('fraud', 0, [{ ...boom, failPolicy: 'closed' }])]);
    const res = await closed.r.run('cart.item.adding', payload);
    expect(res.veto?.code).toBe('extension_unavailable');
    expect(JSON.stringify(res)).not.toContain('secret db password'); // shoppers never see internals
    expect(closed.metrics[0]).toMatchObject({
      outcome: 'error',
      applied: 'vetoed',
      extension: 'fraud',
    });
    expect(closed.logs[0]?.fields.extension).toBe('fraud'); // logged with the extension name
  });

  it('enforces a hard timeout on async work and discards late results', async () => {
    const slow: Partial<CartInterceptor> = {
      timeoutMs: 15,
      handler: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ veto: { code: 'late', message: 'late' } }), 100),
        ),
    };
    const { r, metrics } = runner([loaded('slow', 0, [slow])]);
    const started = performance.now();
    const out = await r.run('cart.item.adding', payload);
    expect(performance.now() - started).toBeLessThan(90);
    expect(out.veto).toBeNull();
    expect(metrics[0]?.outcome).toBe('timeout');
  });

  it('discards the result of a synchronous busy-loop that overran its budget', async () => {
    const busy: Partial<CartInterceptor> = {
      timeoutMs: 5,
      handler: () => {
        const end = Date.now() + 30;
        while (Date.now() < end);
        return { veto: { code: 'late', message: 'late' } };
      },
    };
    const { r, metrics } = runner([loaded('busy', 0, [busy])]);
    expect((await r.run('cart.item.adding', payload)).veto).toBeNull();
    expect(metrics[0]?.outcome).toBe('timeout');
  });

  it('caps an interceptor timeout at the extension budget', async () => {
    const { r, metrics } = runner([
      loaded(
        'capped',
        0,
        [{ timeoutMs: 40, handler: () => new Promise((res) => setTimeout(res, 25)) }],
        5,
      ),
    ]);
    await r.run('cart.item.adding', payload);
    expect(metrics[0]?.outcome).toBe('timeout');
  });

  it('opens a circuit after repeated failures and bypasses without calling the handler', async () => {
    let calls = 0;
    const failing: Partial<CartInterceptor> = {
      handler: () => {
        calls++;
        throw new Error('down');
      },
    };
    const { r, metrics } = runner([loaded('unstable', 0, [failing])], {
      breaker: { failureThreshold: 3, cooldownMs: 60_000 },
    });
    for (let i = 0; i < 6; i++) await r.run('cart.item.adding', payload);
    expect(calls).toBe(3);
    expect(metrics.map((m) => m.outcome)).toEqual([
      'error',
      'error',
      'error',
      'bypassed',
      'bypassed',
      'bypassed',
    ]);
  });

  it('a bypassed fail-closed interceptor still vetoes (declared policy is honoured)', async () => {
    const failing: Partial<CartInterceptor> = {
      failPolicy: 'closed',
      handler: () => {
        throw new Error('down');
      },
    };
    const { r } = runner([loaded('gate', 0, [failing])], {
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });
    await r.run('cart.item.adding', payload);
    const second = await r.run('cart.item.adding', payload);
    expect(second.veto?.code).toBe('extension_unavailable');
  });

  it('fails fast when the bounded pool is saturated', async () => {
    const pool = new Semaphore('tiny', 1, 0);
    // Deterministic: the first interceptor holds the only slot until the test releases it (no timing involved).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const hold: Partial<CartInterceptor> = { timeoutMs: 20, handler: () => gate };
    const { r, metrics } = runner([loaded('holder', 0, [{ ...hold }], 20)], { pool });
    const first = r.run('cart.item.adding', payload);
    while (pool.inFlight === 0) await new Promise((res) => setImmediate(res));
    const second = await r.run('cart.item.adding', payload); // the slot is taken and the queue has no room
    expect(metrics.map((m) => m.outcome)).toEqual(['saturated']);
    expect(second.veto).toBeNull(); // fail-open policy: continue without the extension
    release();
    await first;
  });

  describe('hot-path guard: no network on the cart/checkout path', () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end('ok');
    });
    let url = '';
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('blocks fetch() and never reaches the server', async () => {
      const { r, metrics } = runner([
        loaded('caller', 0, [
          {
            timeoutMs: 40,
            handler: async () => {
              await fetch(url);
            },
          },
        ]),
      ]);
      await r.run('cart.item.adding', payload);
      expect(metrics[0]?.outcome).toBe('violation');
      expect(hits).toBe(0);
    });

    it('blocks raw socket connections', async () => {
      const net = await import('node:net');
      const { r, metrics } = runner([
        loaded('sockets', 0, [
          {
            timeoutMs: 40,
            handler: () =>
              new Promise<void>((res, rej) => {
                const s = net.connect(Number(new URL(url).port), '127.0.0.1', () => res());
                s.on('error', rej);
              }),
          },
        ]),
      ]);
      await r.run('cart.item.adding', payload);
      expect(metrics[0]?.outcome).toBe('violation');
      expect(hits).toBe(0);
    });

    it('does not affect network use outside interceptors', async () => {
      const res = await fetch(url);
      expect(await res.text()).toBe('ok');
      expect(hits).toBe(1);
    });
  });
});
