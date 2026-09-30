import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { redactPaths, resolveRequestId } from './index';

describe('logger redaction', () => {
  it('redacts PII and credentials', () => {
    const chunks: string[] = [];
    const stream = new Writable({ write: (c, _e, cb) => (chunks.push(String(c)), cb()) });
    const log = pino({ redact: { paths: redactPaths, censor: '[redacted]' } }, stream);
    log.info({ customer: { email: 'a@b.com' }, password: 'hunter2', orderId: 'o1' }, 'x');
    const out = chunks.join('');
    expect(out).not.toContain('a@b.com');
    expect(out).not.toContain('hunter2');
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
