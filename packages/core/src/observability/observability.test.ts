import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redactDeep, resolveRequestId, scrubString } from './index';

describe('redactDeep', () => {
  it('redacts sensitive keys at any depth, in any casing or separator style', () => {
    const out = redactDeep({
      accessToken: 'a',
      refreshToken: 'b',
      apiKey: 'c',
      client_secret: 'd',
      passwordHash: 'e',
      'set-cookie': 'f',
      'x-api-key': 'g',
      Authorization: 'h',
      nested: { deeper: { API_KEY: 'i', ok: 'visible' } },
      list: [{ privateKey: 'j' }],
      orderId: 'o1',
    }) as Record<string, unknown>;
    const json = JSON.stringify(out);
    for (const secret of ['"a"', '"b"', '"c"', '"d"', '"e"', '"f"', '"g"', '"h"', '"i"', '"j"'])
      expect(json).not.toContain(secret);
    expect(json).toContain('visible');
    expect(json).toContain('o1');
  });

  it('redacts PII by key, including nested addresses and emails', () => {
    const json = JSON.stringify(
      redactDeep({
        order: {
          customer: { email: 'a@b.com', shippingAddress: { street: '1 Main' }, phone: '0400' },
          id: 'x',
        },
      }),
    );
    expect(json).not.toMatch(/a@b\.com|Main|0400/);
    expect(json).toContain('"id":"x"');
  });

  it('scrubs credentials embedded in strings and error messages', () => {
    expect(scrubString('connect postgres://sold:hunter2@db:5432/sold failed')).not.toContain(
      'hunter2',
    );
    expect(scrubString('Authorization: Bearer abcdef123456789')).not.toContain('abcdef123456789');
    expect(scrubString('key sk_live_abcdefghij12345 used')).not.toContain('abcdefghij12345');
    expect(scrubString('retry with password=hunter2&x=1')).not.toContain('hunter2');
    const err = new Error('connect postgres://u:pw123@h/db refused');
    expect(JSON.stringify(redactDeep({ err }))).not.toContain('pw123');
  });

  it('never mutates its input and survives cycles and deep nesting', () => {
    const input: Record<string, unknown> = { token: 't', keep: 1 };
    input.self = input;
    const out = redactDeep(input) as Record<string, unknown>;
    expect(input.token).toBe('t');
    expect(out.self).toBe('[circular]');
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 30; i++) deep = { d: deep };
    expect(() => redactDeep(deep)).not.toThrow();
  });

  it('keeps Dates and numbers', () => {
    const d = new Date(0);
    expect(redactDeep({ at: d, n: 5 })).toEqual({ at: d, n: 5 });
  });
});

describe('logger', () => {
  it('createLogger applies deep redaction to real log output', () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
    const log = createLogger({ service: 't', level: 'debug', stream });
    log.info(
      { req: { headers: { 'x-api-key': 'k123' } }, customer: { email: 'a@b.com' }, orderId: 'o1' },
      'hello',
    );
    log.error({ err: new Error('connect postgres://u:pw123@h/db refused') }, 'failed');
    const out = lines.join('');
    expect(out).not.toContain('k123');
    expect(out).not.toContain('a@b.com');
    expect(out).not.toContain('pw123');
    expect(out).toContain('o1');
  });
});

describe('resolveRequestId', () => {
  it('keeps well-formed IDs and replaces hostile ones', () => {
    expect(resolveRequestId('req-12345678')).toBe('req-12345678');
    expect(resolveRequestId('bad id\nwith newline')).not.toContain('\n');
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
