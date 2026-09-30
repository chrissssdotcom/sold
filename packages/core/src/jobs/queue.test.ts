import { describe, expect, it } from 'vitest';
import { idempotentJobId, queueClassPolicies, queueClasses } from './queue';

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
