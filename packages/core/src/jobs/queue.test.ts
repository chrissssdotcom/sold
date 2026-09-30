import { describe, expect, it } from 'vitest';
import { assertQueueSafeName, idempotentJobId, queueClassPolicies, queueClasses } from './queue';
import { InMemoryJobQueue } from './memory-queue';

describe('idempotentJobId', () => {
  it('is a deterministic, valid UUID', () => {
    const a = idempotentJobId('emails', 'order-1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idempotentJobId('emails', 'order-1')).toBe(a);
  });
  it('differs by queue and by key', () => {
    expect(idempotentJobId('emails', 'x')).not.toBe(idempotentJobId('webhooks', 'x'));
    expect(idempotentJobId('emails', 'x')).not.toBe(idempotentJobId('emails', 'y'));
  });
});

describe('queue class policies', () => {
  it('order path outranks bulk in priority and concurrency, and has the tightest age budget', () => {
    const [critical, def, bulk] = queueClasses.map((c) => queueClassPolicies[c]);
    expect(critical!.priority).toBeGreaterThan(def!.priority);
    expect(def!.priority).toBeGreaterThan(bulk!.priority);
    expect(critical!.concurrency).toBeGreaterThan(bulk!.concurrency);
    expect(critical!.maxAgeSeconds).toBeLessThan(bulk!.maxAgeSeconds);
  });
});

describe('queue name rules (shared with the real adapter)', () => {
  it('accepts what pg-boss accepts and rejects what it rejects', () => {
    for (const ok of ['ext.loyalty-points.expire', 'loyalty-points/expire', 'a_b.c-d/e'])
      expect(() => assertQueueSafeName('queue', ok)).not.toThrow();
    for (const bad of ['loyalty-points:expire', 'a b', 'a#b', ''])
      expect(() => assertQueueSafeName('queue', bad)).toThrow(/Illegal/);
  });

  it('the in-memory queue enforces them, so illegal names fail in unit tests', async () => {
    const q = new InMemoryJobQueue();
    await expect(q.ensureQueue({ name: 'bad:name', class: 'default' })).rejects.toThrow(
      /Illegal queue/,
    );
    await q.ensureQueue({ name: 'good.name', class: 'default' });
    await expect(q.schedule('good.name', '* * * * *', {}, 'ext:key')).rejects.toThrow(
      /Illegal schedule key/,
    );
    await expect(q.schedule('good.name', '* * * * *', {}, 'ext/key')).resolves.toBeUndefined();
  });
});
