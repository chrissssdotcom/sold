import { describe, expect, it } from 'vitest';
import { bearerMatches } from './auth';
import { evaluateReadiness } from './health';

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
