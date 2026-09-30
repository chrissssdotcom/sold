import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError, TimeoutError, withTimeout } from './circuit-breaker';
import { SaturatedError } from './semaphore';

const boom = () => Promise.reject(new Error('boom'));

describe('CircuitBreaker', () => {
  it('opens after the threshold and fails fast', async () => {
    const b = new CircuitBreaker({ name: 'x', failureThreshold: 3 });
    for (let i = 0; i < 3; i++) await expect(b.exec(boom)).rejects.toThrow('boom');
    expect(b.state).toBe('open');
    await expect(b.exec(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('does not open on non-consecutive failures', async () => {
    const b = new CircuitBreaker({ name: 'x', failureThreshold: 3 });
    await expect(b.exec(boom)).rejects.toThrow();
    await expect(b.exec(boom)).rejects.toThrow();
    await b.exec(async () => 1);
    await expect(b.exec(boom)).rejects.toThrow();
    expect(b.state).toBe('closed');
  });

  it('half-opens after the cooldown, closes on success and re-opens on failure', async () => {
    let t = 0;
    const b = new CircuitBreaker({
      name: 'x',
      failureThreshold: 1,
      cooldownMs: 1000,
      now: () => t,
    });
    await expect(b.exec(boom)).rejects.toThrow();
    expect(b.state).toBe('open');
    t = 1000;
    expect(b.state).toBe('half-open');
    await expect(b.exec(boom)).rejects.toThrow('boom');
    expect(b.state).toBe('open');
    t = 2000;
    expect(await b.exec(async () => 'ok')).toBe('ok');
    expect(b.state).toBe('closed');
  });

  it('allows only one trial call while half-open', async () => {
    let t = 0;
    const b = new CircuitBreaker({ name: 'x', failureThreshold: 1, cooldownMs: 10, now: () => t });
    await expect(b.exec(boom)).rejects.toThrow();
    t = 10;
    let release!: () => void;
    const trial = b.exec(() => new Promise<void>((r) => (release = r)));
    await expect(b.exec(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await trial;
    expect(b.state).toBe('closed');
  });

  it('reports state changes', async () => {
    const seen: string[] = [];
    const b = new CircuitBreaker({
      name: 'db',
      failureThreshold: 1,
      onStateChange: (n, s) => seen.push(`${n}:${s}`),
    });
    await expect(b.exec(boom)).rejects.toThrow();
    expect(seen).toEqual(['db:open']);
  });
});

describe('CircuitBreaker: stale calls, ignored errors, trip', () => {
  const sleepUntil = (release: { fn?: () => void }) =>
    new Promise<string>((r) => (release.fn = () => r('ok')));

  it('an older in-flight success cannot close a breaker that opened after it started', async () => {
    let t = 0;
    const b = new CircuitBreaker({
      name: 'x',
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => t,
    });
    const gate: { fn?: () => void } = {};
    const stale = b.exec(() => sleepUntil(gate));
    await expect(b.exec(boom)).rejects.toThrow();
    await expect(b.exec(boom)).rejects.toThrow();
    expect(b.state).toBe('open');
    gate.fn?.();
    await stale;
    expect(b.state).toBe('open'); // still open: the cooldown has not elapsed and no trial has succeeded
    await expect(b.exec(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
    t = 10_000;
    expect(await b.exec(async () => 1)).toBe(1); // only the half-open trial closes it
    expect(b.state).toBe('closed');
  });

  it('an older in-flight failure does not extend the open period', async () => {
    let t = 0;
    const b = new CircuitBreaker({ name: 'x', failureThreshold: 1, cooldownMs: 100, now: () => t });
    const gate: { fn?: () => void } = {};
    const stale = b.exec(() => sleepUntil(gate).then(() => Promise.reject(new Error('late'))));
    await expect(b.exec(boom)).rejects.toThrow('boom');
    t = 90;
    gate.fn?.();
    await expect(stale).rejects.toThrow('late');
    t = 100;
    expect(b.state).toBe('half-open'); // openedAt was not pushed forward by the stale failure
  });

  it('errors the caller marks as ignorable neither open nor reset the breaker', async () => {
    const b = new CircuitBreaker({
      name: 'x',
      failureThreshold: 2,
      ignoreError: (e) => e instanceof SaturatedError,
    });
    await expect(b.exec(boom)).rejects.toThrow('boom');
    for (let i = 0; i < 10; i++)
      await expect(b.exec(() => Promise.reject(new SaturatedError('p')))).rejects.toBeInstanceOf(
        SaturatedError,
      );
    expect(b.state).toBe('closed');
    await expect(b.exec(boom)).rejects.toThrow('boom'); // the earlier real failure was not forgotten
    expect(b.state).toBe('open');
  });

  it('an ignorable error during the half-open trial leaves the next call to trial again', async () => {
    let t = 0;
    const b = new CircuitBreaker({
      name: 'x',
      failureThreshold: 1,
      cooldownMs: 10,
      now: () => t,
      ignoreError: (e) => e instanceof SaturatedError,
    });
    await expect(b.exec(boom)).rejects.toThrow();
    t = 10;
    await expect(b.exec(() => Promise.reject(new SaturatedError('p')))).rejects.toBeInstanceOf(
      SaturatedError,
    );
    expect(await b.exec(async () => 'ok')).toBe('ok');
    expect(b.state).toBe('closed');
  });

  it('trip() opens the circuit immediately and it recovers after the cooldown', async () => {
    let t = 0;
    const b = new CircuitBreaker({ name: 'x', failureThreshold: 5, cooldownMs: 50, now: () => t });
    b.trip();
    expect(b.state).toBe('open');
    await expect(b.exec(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
    t = 50;
    expect(await b.exec(async () => 1)).toBe(1);
    expect(b.state).toBe('closed');
  });
});

describe('withTimeout', () => {
  it('resolves fast work and rejects slow work', async () => {
    expect(await withTimeout(Promise.resolve(1), 50, 'fast')).toBe(1);
    await expect(withTimeout(new Promise(() => undefined), 10, 'slow')).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });
});
