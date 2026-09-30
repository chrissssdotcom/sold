import { describe, expect, it } from 'vitest';
import { bearerMatches } from './auth';
import { cachedReadiness, evaluateReadiness } from './health';

const up = async () => undefined;
const down = async () => {
  throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
};
const never = () => new Promise<void>(() => undefined);

describe('evaluateReadiness', () => {
  it('ok when everything is up or skipped', async () => {
    const r = await evaluateReadiness({ isDraining: () => false, checkPrimary: up });
    expect(r.status).toBe('ok');
    expect(r.checks.replica?.status).toBe('skipped');
  });

  it('degraded (still ready) when replica or redis is down', async () => {
    expect(
      (await evaluateReadiness({ isDraining: () => false, checkPrimary: up, checkReplica: down }))
        .status,
    ).toBe('degraded');
    expect(
      (await evaluateReadiness({ isDraining: () => false, checkPrimary: up, checkRedis: down }))
        .status,
    ).toBe('degraded');
  });

  it('unavailable when the primary is down, even if others are up', async () => {
    const r = await evaluateReadiness({
      isDraining: () => false,
      checkPrimary: down,
      checkReplica: up,
    });
    expect(r.status).toBe('unavailable');
  });

  it('unavailable while draining', async () => {
    expect((await evaluateReadiness({ isDraining: () => true, checkPrimary: up })).status).toBe(
      'unavailable',
    );
  });

  it('times out a hung dependency instead of hanging the probe', async () => {
    const started = Date.now();
    const r = await evaluateReadiness({
      isDraining: () => false,
      checkPrimary: never,
      timeoutMs: 50,
    });
    expect(r.status).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('never leaks connection details from errors', async () => {
    const r = await evaluateReadiness({ isDraining: () => false, checkPrimary: down });
    expect(JSON.stringify(r)).not.toMatch(/hunter2|10\.0\.0\.5/);
  });
});

describe('bearerMatches', () => {
  it('accepts only the exact token and fails closed when unset', () => {
    expect(bearerMatches('Bearer secret-token', 'secret-token')).toBe(true);
    expect(bearerMatches('Bearer wrong-token-', 'secret-token')).toBe(false);
    expect(bearerMatches('Bearer secret-token', undefined)).toBe(false);
    expect(bearerMatches(null, 'secret-token')).toBe(false);
    expect(bearerMatches('secret-token', 'secret-token')).toBe(false);
  });
});

describe('cachedReadiness', () => {
  it('runs dependency checks at most once per TTL and shares in-flight checks', async () => {
    let calls = 0;
    let t = 0;
    const check = cachedReadiness({ isDraining: () => false, checkPrimary: async () => void calls++ }, 1_000, () => t);
    await Promise.all(Array.from({ length: 50 }, () => check()));
    await check();
    expect(calls).toBe(1);
    t = 1_001;
    await check();
    expect(calls).toBe(2);
  });

  it('caches failures briefly so a struggling primary is not hammered', async () => {
    let calls = 0;
    const check = cachedReadiness({ isDraining: () => false, checkPrimary: async () => { calls++; throw new Error('down'); } }, 1_000, () => 0);
    for (let i = 0; i < 20; i++) expect((await check()).status).toBe('unavailable');
    expect(calls).toBe(1);
  });

  it('reflects draining immediately, without waiting for the cache', async () => {
    let draining = false;
    const check = cachedReadiness({ isDraining: () => draining, checkPrimary: async () => undefined }, 60_000, () => 0);
    expect((await check()).status).toBe('ok');
    draining = true;
    const res = await check();
    expect(res.status).toBe('unavailable');
    expect(res.draining).toBe(true);
  });
});
