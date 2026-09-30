import { describe, expect, it } from 'vitest';
import extension from './index';

const log = { debug() {}, info() {}, warn() {}, error() {} };

describe('__NAME__', () => {
  it('declares what it contributes', () => {
    expect(extension.name).toBe('__NAME__');
    expect(extension.tablePrefix).toBe('__PREFIX__');
    expect(extension.observers.map((o) => o.name)).toEqual(['record-order']);
    expect(extension.routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /hello']);
  });

  it('serves the greeting from settings', async () => {
    const route = extension.routes[0];
    const ctx = {
      extension: '__NAME__',
      log,
      signal: new AbortController().signal,
      settings: { get: async () => ({ greeting: 'Hi' }) },
      db: {},
      queue: { enqueue: async () => null },
      actor: null,
      requestId: 'test-request',
      params: {},
    };
    const res = await route?.handler(new Request('http://localhost/x/__NAME__/hello'), ctx as never);
    expect(await res?.json()).toEqual({ message: 'Hi' });
  });
});
