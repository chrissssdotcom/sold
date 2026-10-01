import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  defineExtension,
  type InterceptorContext,
  type InterceptorDefinition,
} from '@sold/extension-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Semaphore } from '../resilience/semaphore';
import {
  installHotPathGuard,
  onHotPathBlocked,
  uninstallHotPathGuard,
  type HotPathBlockedEvent,
} from './hot-path-guard';
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
  over: {
    pool?: Semaphore;
    breaker?: { failureThreshold?: number; cooldownMs?: number };
    perExtension?: { size?: number; queue?: number };
    maxQueueWaitMs?: number;
  } = {},
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
    ...(over.perExtension ? { perExtension: over.perExtension } : {}),
    ...(over.maxQueueWaitMs !== undefined ? { maxQueueWaitMs: over.maxQueueWaitMs } : {}),
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('InterceptorRunner: results are read inside the guarded region', () => {
  const cases: [string, () => unknown][] = [
    [
      'a throwing veto getter',
      () => ({
        get veto() {
          throw new Error('boom');
        },
      }),
    ],
    [
      'a throwing modify getter',
      () => ({
        veto: undefined,
        get modify() {
          throw new Error('boom');
        },
      }),
    ],
    [
      'a Proxy that throws on any trap',
      () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error('boom');
            },
            ownKeys() {
              throw new Error('boom');
            },
          },
        ),
    ],
    [
      'a modify Proxy that throws',
      () => ({
        modify: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('boom');
            },
            getPrototypeOf() {
              throw new Error('boom');
            },
          },
        ),
      }),
    ],
    ['a modify that cannot be cloned', () => ({ modify: { quantity: () => 1 } })],
  ];

  for (const [label, make] of cases) {
    it(`${label} is an ordinary extension error: run() resolves and failPolicy applies`, async () => {
      const open = runner([loaded('bad', 0, [{ handler: make as never, failPolicy: 'open' }])]);
      expect(await open.r.run('cart.item.adding', payload)).toEqual({ payload, veto: null });
      expect(open.metrics[0]).toMatchObject({ applied: 'continued' });
      expect(open.metrics[0]?.outcome).toMatch(/^(error|invalid-modify)$/);
      const closed = runner([loaded('bad', 0, [{ handler: make as never, failPolicy: 'closed' }])]);
      expect((await closed.r.run('cart.item.adding', payload)).veto?.code).toBe(
        'extension_unavailable',
      );
    });
  }

  it('a result that throws when read counts against the breaker', async () => {
    const { r, metrics } = runner(
      [
        loaded('bad', 0, [
          {
            handler: (() => ({
              get veto() {
                throw new Error('boom');
              },
            })) as never,
          },
        ]),
      ],
      { breaker: { failureThreshold: 2, cooldownMs: 60_000 } },
    );
    for (let i = 0; i < 3; i++) await r.run('cart.item.adding', payload);
    expect(metrics.map((m) => m.outcome)).toEqual(['error', 'error', 'bypassed']);
  });

  it('invalid modifications count as failures, so a persistently invalid extension is bypassed', async () => {
    const { r, metrics } = runner(
      [loaded('sloppy', 0, [{ handler: () => ({ modify: { quantity: -5 } }) }], 50)], // not a timing test: the largest budget a manifest allows keeps load from turning it into a timeout
      { breaker: { failureThreshold: 3, cooldownMs: 60_000 } },
    );
    for (let i = 0; i < 5; i++) await r.run('cart.item.adding', payload);
    expect(metrics.map((m) => m.outcome)).toEqual([
      'invalid-modify',
      'invalid-modify',
      'invalid-modify',
      'bypassed',
      'bypassed',
    ]);
  });
});

describe('InterceptorRunner: veto text is inert', () => {
  it('strips control, bidi and angle-bracket characters and truncates to 200 characters', async () => {
    const evil = `<img src=x onerror=alert(1)>\n\u202Eevil\u2066 \u200Bok\u0007 ${'A'.repeat(500)}`;
    const { r } = runner([
      loaded('rude', 0, [{ handler: () => ({ veto: { code: 'no', message: evil } }) }]),
    ]);
    const { veto } = await r.run('cart.item.adding', payload);
    for (const ch of ['<', '>', '\u202E', '\u2066', '\u200B', '\u0007', '\n'])
      expect(veto?.message).not.toContain(ch);
    expect(veto?.message).toContain('img src=x onerror=alert(1)');
    expect([...(veto?.message ?? '')].length).toBeLessThanOrEqual(200);
  });

  it('falls back to a generic message when nothing printable is left', async () => {
    const { r } = runner([
      loaded('rude', 0, [{ handler: () => ({ veto: { code: 'no', message: '\u202E<>\n' } }) }]),
    ]);
    expect((await r.run('cart.item.adding', payload)).veto?.message).toBe('Not allowed (rude).');
  });
});

describe('InterceptorRunner: pools, budgets and breakers', () => {
  it('queue wait is not charged to the budget: a healthy 8ms interceptor never times out on a 1-slot pool', async () => {
    const { r, metrics } = runner(
      // 8 calls x 15 ms through one slot: the last waits ~105 ms, longer than the 50 ms budget, yet none may time out (each runs 15 ms)
      [loaded('healthy', 0, [{ failPolicy: 'closed', handler: () => sleep(15) }], 50)],
      { pool: new Semaphore('one', 1, 50), maxQueueWaitMs: 5_000 },
    );
    await Promise.all(Array.from({ length: 8 }, () => r.run('cart.item.adding', payload)));
    expect(metrics.map((m) => m.outcome)).toEqual(Array(8).fill('ok'));
  });

  it('a bounded wait fails fast as saturated, never as a timeout, and does not open the breaker', async () => {
    const { r, metrics } = runner(
      [loaded('healthy', 0, [{ failPolicy: 'closed', handler: () => sleep(8) }], 50)],
      {
        pool: new Semaphore('one', 1, 50),
        maxQueueWaitMs: 12,
        breaker: { failureThreshold: 2, cooldownMs: 60_000 },
      },
    );
    await Promise.all(Array.from({ length: 12 }, () => r.run('cart.item.adding', payload)));
    const outcomes = metrics.map((m) => m.outcome);
    expect(outcomes).not.toContain('timeout');
    expect(outcomes).not.toContain('bypassed'); // saturation is not the extension's failure
    expect(outcomes).toContain('saturated');
    expect(outcomes).toContain('ok');
    // and once the load is gone it serves again
    expect((await r.run('cart.item.adding', payload)).veto).toBeNull();
    expect(metrics.at(-1)?.outcome).toBe('ok');
  });

  it('a slow neighbour cannot starve an innocent fail-closed extension (per-extension pools)', async () => {
    const { r, metrics } = runner(
      [
        loaded('slow', 0, [{ handler: () => sleep(60) }], 40),
        loaded('victim', 1, [{ failPolicy: 'closed', handler: () => undefined }], 20),
      ],
      {
        pool: new Semaphore('global', 8, 8),
        perExtension: { size: 4, queue: 32 },
        maxQueueWaitMs: 5,
        breaker: { failureThreshold: 2, cooldownMs: 60_000 },
      },
    );
    const results = await Promise.all(
      Array.from({ length: 16 }, () => r.run('cart.item.adding', payload)),
    );
    const victim = metrics.filter((m) => m.extension === 'victim').map((m) => m.outcome);
    expect(victim).toEqual(Array(16).fill('ok'));
    expect(results.every((x) => x.veto === null)).toBe(true);
    expect(metrics.some((m) => m.extension === 'slow' && m.outcome !== 'ok')).toBe(true);
  });

  it('a stale success from before the breaker opened cannot close it (only the half-open trial can)', async () => {
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let calls = 0;
    const { r, metrics } = runner(
      [
        loaded(
          'flappy',
          0,
          [
            {
              handler: () => {
                calls++;
                if (calls === 1) return held.then(() => undefined); // in flight while the breaker opens
                throw new Error('down');
              },
            },
          ],
          40,
        ),
      ],
      { breaker: { failureThreshold: 2, cooldownMs: 60_000 } },
    );
    const inflight = r.run('cart.item.adding', payload);
    await r.run('cart.item.adding', payload);
    await r.run('cart.item.adding', payload);
    release();
    await inflight;
    await r.run('cart.item.adding', payload);
    expect(metrics.map((m) => m.outcome)).toEqual(['error', 'error', 'ok', 'bypassed']);
  });
});

describe('InterceptorRunner: a blocked event loop is detected, attributed and cut off', () => {
  const busy = (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end);
  };

  it('a synchronous stall past the budget is reported with the interceptor named', async () => {
    const events: HotPathBlockedEvent[] = [];
    const off = onHotPathBlocked((e) => events.push(e));
    try {
      const { r } = runner([
        loaded('stall', 0, [{ name: 'spin', timeoutMs: 10, handler: () => busy(25) }], 10),
      ]);
      await r.run('cart.item.adding', payload);
    } finally {
      off();
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      extension: 'stall',
      interceptor: 'spin',
      budgetMs: 10,
      source: 'sync-call',
    });
    expect(events[0]?.blockedMs).toBeGreaterThanOrEqual(24);
  });

  it('one call blocking for more than 5x its budget opens the breaker at once (next call is bypassed)', async () => {
    let calls = 0;
    const { r, metrics } = runner(
      [loaded('stall', 0, [{ handler: () => (calls++, busy(60)) }], 10)],
      { breaker: { failureThreshold: 5, cooldownMs: 60_000 } },
    );
    await r.run('cart.item.adding', payload);
    await r.run('cart.item.adding', payload);
    expect(calls).toBe(1);
    expect(metrics.map((m) => m.outcome)).toEqual(['timeout', 'bypassed']);
  });

  it('a stall under 5x the budget is discarded and counted as a normal failure only', async () => {
    let calls = 0;
    const { r, metrics } = runner(
      [loaded('stall', 0, [{ handler: () => (calls++, busy(40)) }], 20)], // 2x the budget, 60 ms under the 5x cut-off even if the process is descheduled
      { breaker: { failureThreshold: 5, cooldownMs: 60_000 } },
    );
    await r.run('cart.item.adding', payload);
    await r.run('cart.item.adding', payload);
    expect(calls).toBe(2);
    expect(metrics.map((m) => m.outcome)).toEqual(['timeout', 'timeout']);
  });
});

describe('hot-path guard: what it stops, and what it records', () => {
  it('refuses to spawn a process, start a worker, send UDP, resolve DNS or Atomics.wait', async () => {
    const cp = await import('node:child_process');
    const dgram = await import('node:dgram');
    const dns = await import('node:dns');
    const wt = await import('node:worker_threads');
    const attempts: Record<string, () => unknown> = {
      execSync: () => cp.execSync('echo nope'),
      spawn: () => cp.spawn('true'),
      worker: () => new wt.Worker('process.exit(0)', { eval: true }),
      udp: () => dgram.createSocket('udp4').send('x', 9, '127.0.0.1'),
      dns: () => dns.lookup('localhost', () => undefined),
      atomics: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20),
    };
    for (const [label, attempt] of Object.entries(attempts)) {
      const { r, metrics } = runner([
        loaded(`no-${label.toLowerCase()}`, 0, [{ handler: async () => void attempt() }]),
      ]);
      await r.run('cart.item.adding', payload);
      expect(metrics[0]?.outcome, label).toBe('violation');
    }
  });

  it('a handler that swallows the violation still fails the call', async () => {
    const { r, metrics } = runner([
      loaded('sneaky', 0, [
        {
          handler: async () => {
            await fetch('http://127.0.0.1:9/').catch(() => undefined);
          },
        },
      ]),
    ]);
    await r.run('cart.item.adding', payload);
    expect(metrics[0]?.outcome).toBe('violation');
  });

  it('records (and fails the call for) a write on an already-open socket, without wedging it', async () => {
    const net = await import('node:net');
    let received = '';
    const server = net.createServer((s) => s.on('data', (d) => (received += d)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const socket = net.connect((server.address() as AddressInfo).port, '127.0.0.1');
    await new Promise((r) => socket.once('connect', r));
    try {
      const { r, metrics } = runner([
        loaded('pooled', 0, [{ handler: async () => void socket.write('ping') }]),
      ]);
      await r.run('cart.item.adding', payload);
      expect(metrics[0]?.outcome).toBe('violation');
      await sleep(30);
      expect(received).toBe('ping'); // detection, not prevention: the shared connection is not corrupted
    } finally {
      socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not flag console output (stdout/stderr are sockets when piped)', async () => {
    const { r, metrics } = runner([
      loaded('chatty', 0, [{ handler: async () => void process.stderr.write('') }]),
    ]);
    await r.run('cart.item.adding', payload);
    expect(metrics[0]?.outcome).toBe('ok');
  });

  it('removes Object.prototype pollution and fails the call', async () => {
    const { r, metrics } = runner([
      loaded('polluter', 0, [
        {
          handler: async () => {
            (Object.prototype as Record<string, unknown>).isAdmin = true;
          },
        },
      ]),
    ]);
    await r.run('cart.item.adding', payload);
    expect(metrics[0]?.outcome).toBe('violation');
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });
});
