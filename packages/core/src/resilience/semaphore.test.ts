import { describe, expect, it } from 'vitest';
import { SaturatedError, Semaphore } from './semaphore';

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Semaphore', () => {
  it('hands slots over in order and releases are idempotent', async () => {
    const s = new Semaphore('s', 1, 2);
    const first = await s.acquire();
    const order: string[] = [];
    const second = s.acquire().then((release) => (order.push('b'), release));
    const third = s.acquire().then((release) => (order.push('c'), release));
    expect(s.queued).toBe(2);
    first();
    first(); // a double release must not free a slot twice
    (await second)();
    (await third)();
    expect(order).toEqual(['b', 'c']);
    expect(s.inFlight).toBe(0);
  });

  it('rejects immediately when the queue is full', async () => {
    const s = new Semaphore('s', 1, 0);
    const release = await s.acquire();
    await expect(s.acquire()).rejects.toBeInstanceOf(SaturatedError);
    release();
  });

  it('gives up waiting after maxWaitMs and leaves the queue consistent', async () => {
    const s = new Semaphore('s', 1, 5);
    const release = await s.acquire();
    const started = performance.now();
    await expect(s.acquire(15)).rejects.toBeInstanceOf(SaturatedError);
    expect(performance.now() - started).toBeGreaterThanOrEqual(10);
    expect(s.queued).toBe(0);
    release();
    expect(s.inFlight).toBe(0);
    const again = await s.acquire(15); // the timed-out waiter did not consume the slot
    again();
  });

  it('run() releases on failure', async () => {
    const s = new Semaphore('s', 1, 0);
    await expect(s.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(s.inFlight).toBe(0);
    await tick(0);
  });
});
