import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RedisQueue } from './redis';

/** The JobQueue contract, exercised against a real Redis with tiny delays. */
let redis: Redis;
const queues: RedisQueue[] = [];
beforeAll(() => {
  redis = new Redis(process.env['SOLD_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379');
});
afterAll(async () => {
  await redis.quit();
});
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.stop({ timeoutMs: 500 })));
});

const fast = {
  default: {
    retryDelaySeconds: 0.05,
    retryDelayMaxSeconds: 0.4,
    retryLimit: 3,
    expireInSeconds: 1,
    concurrency: 4,
  },
};
function make(prefix: string, over: Partial<ConstructorParameters<typeof RedisQueue>[0]> = {}) {
  const q = new RedisQueue({ redis, prefix, policies: fast, pollIntervalMs: 20, ...over });
  queues.push(q);
  return q;
}
const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting');
};
const fresh = () => `t${randomUUID().slice(0, 8)}`;

describe('RedisQueue', () => {
  it('runs a job with its data', async () => {
    const q = make(fresh());
    await q.ensureQueue({ name: 'jobs', class: 'default' });
    const seen: unknown[] = [];
    await q.start();
    await q.work<{ n: number }>('jobs', async (j) => void seen.push([j.data.n, j.retryCount]));
    await q.enqueue('jobs', { n: 7 });
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual([7, 0]);
  });

  it('enqueue with an idempotency key is a no-op the second time', async () => {
    const q = make(fresh());
    await q.ensureQueue({ name: 'jobs', class: 'default' });
    const a = await q.enqueue('jobs', { x: 1 }, { idempotencyKey: 'order-1' });
    const b = await q.enqueue('jobs', { x: 1 }, { idempotencyKey: 'order-1' });
    const c = await q.enqueue('jobs', { x: 1 }, { idempotencyKey: 'order-2' });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    expect(c).toBeTruthy();
    expect((await q.health('jobs')).depth).toBe(2);
  });

  it('retries with backoff, then dead-letters after the retry limit', async () => {
    const q = make(fresh());
    await q.ensureQueue({ name: 'jobs', class: 'default' });
    const attempts: number[] = [];
    const times: number[] = [];
    await q.start();
    await q.work('jobs', async (j) => {
      attempts.push(j.retryCount);
      times.push(Date.now());
      throw new Error('always fails');
    });
    await q.enqueue('jobs', {});
    await until(async () => (await q.health('jobs')).deadLetterDepth === 1);
    expect(attempts).toEqual([0, 1, 2, 3]); // first try + 3 retries
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(times[1]! - times[0]! - 30); // backoff grows (jitter allowed)
    expect((await q.health('jobs')).depth).toBe(0);
  });

  it('a job that fails once and then succeeds is not dead-lettered', async () => {
    const q = make(fresh());
    await q.ensureQueue({ name: 'jobs', class: 'default' });
    let n = 0;
    await q.start();
    await q.work('jobs', async () => {
      if (++n === 1) throw new Error('transient');
    });
    await q.enqueue('jobs', {});
    await until(() => n === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(await q.health('jobs')).toMatchObject({ depth: 0, deadLetterDepth: 0 });
  });

  it('delayed jobs wait; health reports the age of what is ready but unstarted', async () => {
    const q = make(fresh());
    await q.ensureQueue({ name: 'jobs', class: 'default' });
    await q.enqueue('jobs', {}, { startAfterSeconds: 0.4 });
    expect((await q.health('jobs')).depth).toBe(0); // not ready yet
    await new Promise((r) => setTimeout(r, 1300));
    const h = await q.health('jobs');
    expect(h.depth).toBe(1);
    expect(h.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('never runs more than the class concurrency at once, and runs everything', async () => {
    const q = make(fresh());
    await q.ensureQueue({ name: 'jobs', class: 'default' });
    let running = 0;
    let peak = 0;
    let done = 0;
    await q.start();
    await q.work('jobs', async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      done++;
    });
    for (let i = 0; i < 20; i++) await q.enqueue('jobs', { i });
    await until(() => done === 20);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('two workers on one queue run each job exactly once (no double claim)', async () => {
    const prefix = fresh();
    const a = make(prefix);
    const b = make(prefix);
    for (const q of [a, b]) await q.ensureQueue({ name: 'jobs', class: 'default' });
    const ran: number[] = [];
    for (const q of [a, b]) {
      await q.start();
      await q.work<{ i: number }>('jobs', async (j) => void ran.push(j.data.i));
    }
    for (let i = 0; i < 60; i++) await a.enqueue('jobs', { i });
    await until(() => ran.length >= 60);
    await new Promise((r) => setTimeout(r, 200));
    expect(ran.length).toBe(60);
    expect(new Set(ran).size).toBe(60);
  });

  it('a worker that dies mid-job loses its lease and the job is retried elsewhere (at-least-once)', async () => {
    const prefix = fresh();
    const dying = make(prefix, {
      policies: { default: { ...fast.default, expireInSeconds: 0.4 } },
    });
    await dying.ensureQueue({ name: 'jobs', class: 'default' });
    let claimed = false;
    await dying.start();
    await dying.work('jobs', () => {
      claimed = true;
      return new Promise<void>(() => undefined); // hangs forever: simulates a crashed worker holding the job
    });
    await dying.enqueue('jobs', { marker: 1 });
    await until(() => claimed);
    await dying.stop({ timeoutMs: 50 }); // the process is gone: no more polling or reaping from it, its handler never returns
    const survivor = make(prefix, {
      policies: { default: { ...fast.default, expireInSeconds: 0.4 } },
    });
    await survivor.ensureQueue({ name: 'jobs', class: 'default' });
    const retried: number[] = [];
    await survivor.start();
    await survivor.work('jobs', async (j) => void retried.push(j.retryCount));
    await until(() => retried.length === 1, 6000);
    expect(retried[0]).toBe(1); // the lost attempt counted
  });

  it('a lost-lease job that keeps crashing is eventually dead-lettered, not retried forever', async () => {
    const prefix = fresh();
    const pol = { default: { ...fast.default, expireInSeconds: 0.2, retryLimit: 1 } };
    const q = make(prefix, { policies: pol });
    await q.ensureQueue({ name: 'jobs', class: 'default' });
    await q.start();
    await q.work('jobs', () => new Promise<void>(() => undefined));
    await q.enqueue('jobs', {});
    await until(async () => (await q.health('jobs')).deadLetterDepth === 1, 8000);
  });

  it('stop() waits for in-flight work, then refuses to start more', async () => {
    const q = make(fresh());
    await q.ensureQueue({ name: 'jobs', class: 'default' });
    let finished = false;
    let started = false;
    await q.start();
    await q.work('jobs', async () => {
      started = true;
      await new Promise((r) => setTimeout(r, 300));
      finished = true;
    });
    await q.enqueue('jobs', {});
    await until(() => started);
    await q.stop({ timeoutMs: 3000 });
    expect(finished).toBe(true);
    await q.enqueue('jobs', {});
    await new Promise((r) => setTimeout(r, 150));
    expect((await q.health('jobs')).depth).toBe(1); // nothing picked it up
  });

  // Waits for a real minute boundary (up to ~61 s), so it only runs when asked: SOLD_SLOW_TESTS=1.
  it.skipIf(!process.env['SOLD_SLOW_TESTS'])(
    'a cron schedule on two workers fires once per minute, not twice',
    { timeout: 150_000 },
    async () => {
      const prefix = fresh();
      const a = make(prefix);
      const b = make(prefix);
      for (const q of [a, b]) await q.ensureQueue({ name: 'cron', class: 'default' });
      const fired: number[] = [];
      for (const q of [a, b]) {
        await q.start();
        await q.work('cron', async () => void fired.push(Date.now()));
        await q.schedule('cron', '* * * * *', { tick: true });
      }
      await until(() => fired.length >= 1, 75_000);
      await new Promise((r) => setTimeout(r, 3_000));
      expect(fired.length).toBe(1);
    },
  );

  it('rejects illegal queue names and undeclared queues', async () => {
    const q = make(fresh());
    await expect(q.ensureQueue({ name: 'bad name!', class: 'default' })).rejects.toThrow(/Illegal/);
    await expect(q.enqueue('nope', {})).rejects.toThrow(/not been declared/);
  });
});
