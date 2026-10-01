import { describe, expect, it } from 'vitest';
import { isDependencyUnavailable } from './availability';

const wrapped = (cause: unknown) =>
  Object.assign(new Error('Failed query: select 1 params: '), { cause });

describe('isDependencyUnavailable', () => {
  it('recognises a refused or reset connection, also when wrapped by drizzle', () => {
    expect(isDependencyUnavailable(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      true,
    );
    expect(isDependencyUnavailable(wrapped(Object.assign(new Error('x'), { code: '57P03' })))).toBe(
      true,
    );
    expect(isDependencyUnavailable(wrapped(new Error('Connection terminated unexpectedly')))).toBe(
      true,
    );
    expect(
      isDependencyUnavailable(wrapped(new Error('timeout exceeded when trying to connect'))),
    ).toBe(true);
  });
  it('recognises AggregateError connect failures', () => {
    const agg = Object.assign(
      new AggregateError([Object.assign(new Error(''), { code: 'ECONNREFUSED' })]),
      {},
    );
    expect(isDependencyUnavailable(wrapped(agg))).toBe(true);
  });
  it('does not treat bugs, constraint violations or query timeouts as outages', () => {
    expect(isDependencyUnavailable(new TypeError('x is not a function'))).toBe(false);
    expect(
      isDependencyUnavailable(wrapped(Object.assign(new Error('dup'), { code: '23505' }))),
    ).toBe(false);
    expect(
      isDependencyUnavailable(
        wrapped(
          Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          }),
        ),
      ),
    ).toBe(false);
    expect(isDependencyUnavailable('string')).toBe(false);
    expect(isDependencyUnavailable(null)).toBe(false);
  });
  it('is not fooled by user data inside the wrapper message, and survives cycles', () => {
    expect(isDependencyUnavailable(new Error('Failed query: ... params: connection refused'))).toBe(
      false,
    );
    expect(isDependencyUnavailable(new Error('connection refused'))).toBe(true);
    const a: { cause?: unknown } = new Error('loop');
    a.cause = a;
    expect(isDependencyUnavailable(a)).toBe(false);
  });
});
