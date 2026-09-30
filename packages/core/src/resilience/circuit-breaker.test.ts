import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError, TimeoutError, withTimeout } from './circuit-breaker';

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

describe('withTimeout', () => {
  it('resolves fast work and rejects slow work', async () => {
    expect(await withTimeout(Promise.resolve(1), 50, 'fast')).toBe(1);
    await expect(withTimeout(new Promise(() => undefined), 10, 'slow')).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });
});
