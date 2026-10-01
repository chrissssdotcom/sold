import { createServer, type Server } from 'node:http';
import type { ExtensionContext } from '@sold/extension-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPayload, hashEmail, toMajor } from './events';
import { paymentEvent, placeOrderEvent } from './server-events.observer';
import type { Settings } from './settings';

describe('events payload', () => {
  it('hashes the normalised email with SHA-256 and never sends the address', () => {
    // sha256("sam@example.com")
    // Known vector: sha256("test@example.com")
    expect(hashEmail(' Test@Example.com ')).toBe(
      '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b',
    );
    expect(hashEmail('A@b.co')).toBe(hashEmail(' a@B.co '));
    expect(hashEmail('a@b.co')).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.stringify(
      buildPayload('PIXEL123ABC', {
        event: 'PlaceAnOrder',
        eventId: 'order-1',
        occurredAt: new Date('2026-01-02T03:04:05Z'),
        email: 'sam@example.com',
        currency: 'AUD',
        amountMinor: '2599',
      }),
    );
    expect(body).not.toContain('sam@example.com');
    expect(JSON.parse(body).data[0]).toMatchObject({
      event: 'PlaceAnOrder',
      event_id: 'order-1',
      event_time: 1767323045,
      properties: { currency: 'AUD', value: 25.99 },
    });
  });

  it('converts minor to major units by the currency exponent', () => {
    expect(toMajor('2599', 'AUD')).toBe(25.99);
    expect(toMajor('1500', 'JPY')).toBe(1500);
    expect(toMajor('5', 'AUD')).toBe(0.05);
  });
});

// ---- observer, against a fake TikTok and a tiny fake database --------------------------------------------------

interface TikTokBody {
  event_source_id: string;
  data: { event: string; event_id: string; page?: { url: string } }[];
}
interface Call {
  headers: Record<string, unknown>;
  body: TikTokBody;
}

let server: Server | undefined;
afterEach(() => void server?.close());

function fakeTikTok(reply: { status: number; json: object }) {
  return new Promise<{ url: string; calls: Call[] }>((resolve) => {
    const calls: Call[] = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push({ headers: req.headers, body: JSON.parse(raw) as TikTokBody });
        res
          .writeHead(reply.status, { 'content-type': 'application/json' })
          .end(JSON.stringify(reply.json));
      });
    }).listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, calls }),
    );
  });
}

/** Just enough of a database for the observer's three statements; keyed on the SQL text. */
function fakeDb(
  order: { email: string; consent: { marketing?: boolean } } | null,
  sent = new Set<string>(),
) {
  const textOf = (q: { queryChunks: unknown[] }) =>
    q.queryChunks
      .map((c) =>
        typeof c === 'object' && c && 'value' in c
          ? (c as { value: string[] }).value.join('')
          : '?',
      )
      .join('');
  const paramsOf = (q: { queryChunks: unknown[] }) =>
    q.queryChunks.filter((c) => typeof c === 'string');
  return {
    sent,
    primary: {
      async execute(q: { queryChunks: unknown[] }) {
        const t = textOf(q);
        if (t.includes('FROM orders')) return { rows: order ? [order] : [] };
        if (t.includes('SELECT 1 FROM ext_tiktok_social_sent'))
          return { rows: sent.has(String(paramsOf(q)[0])) ? [{}] : [] };
        if (t.includes('INSERT INTO ext_tiktok_social_sent')) {
          sent.add(String(paramsOf(q)[0]));
          return { rows: [] };
        }
        throw new Error(`unexpected SQL: ${t}`);
      },
    },
  };
}

const logs: unknown[] = [];
const ctxFor = (settings: Partial<Settings>, db: ReturnType<typeof fakeDb>) =>
  ({
    extension: 'tiktok-social',
    log: { warn: (...a: unknown[]) => logs.push(a), info() {}, error() {}, debug() {} },
    settings: {
      get: async () => ({
        serverEvents: true,
        pixelCode: 'PIXEL123ABC',
        accessToken: 'secret-token',
        apiBase: 'http://x',
        ...settings,
      }),
    },
    db,
    signal: new AbortController().signal,
    eventId: 'e1',
    attempt: 1,
  }) as unknown as ExtensionContext<Settings> & { eventId: string; attempt: number };

const placed = {
  orderId: '00000000-0000-7000-8000-000000000001',
  orderNumber: '1001',
  customerId: null,
  total: { amount: 2599n, currency: 'AUD' },
  placedAt: new Date('2026-01-02T03:04:05Z'),
  marketingConsent: true,
};

describe('server-side conversions', () => {
  it('sends a PlaceAnOrder for a consenting order, with the token in a header and a stable event id, once', async () => {
    const t = await fakeTikTok({ status: 200, json: { code: 0, message: 'OK' } });
    const db = fakeDb({ email: 'sam@example.com', consent: { marketing: true } });
    const ctx = ctxFor({ apiBase: t.url, publicUrl: 'https://shop.example' }, db);
    await placeOrderEvent.handler(placed, ctx);
    await placeOrderEvent.handler(placed, ctx); // redelivery
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.headers['access-token']).toBe('secret-token');
    expect(t.calls[0]!.body.event_source_id).toBe('PIXEL123ABC');
    expect(t.calls[0]!.body.data[0]).toMatchObject({
      event: 'PlaceAnOrder',
      event_id: `order-${placed.orderId}`,
      page: { url: 'https://shop.example' },
    });
    expect(JSON.stringify(t.calls[0]!.body)).not.toContain('sam@example.com');
    expect(db.sent.has(`order-${placed.orderId}`)).toBe(true);
  });

  it('sends nothing without recorded advertising consent, or when the feature is off or unconfigured', async () => {
    const t = await fakeTikTok({ status: 200, json: { code: 0 } });
    const base = { apiBase: t.url };
    await placeOrderEvent.handler(
      placed,
      ctxFor(base, fakeDb({ email: 'a@b.co', consent: { marketing: false } })),
    );
    await placeOrderEvent.handler(placed, ctxFor(base, fakeDb({ email: 'a@b.co', consent: {} })));
    await placeOrderEvent.handler(
      placed,
      ctxFor(
        { ...base, serverEvents: false },
        fakeDb({ email: 'a@b.co', consent: { marketing: true } }),
      ),
    );
    await placeOrderEvent.handler(
      placed,
      ctxFor(
        { ...base, accessToken: undefined },
        fakeDb({ email: 'a@b.co', consent: { marketing: true } }),
      ),
    );
    await placeOrderEvent.handler(
      placed,
      ctxFor(
        { ...base, pixelCode: undefined },
        fakeDb({ email: 'a@b.co', consent: { marketing: true } }),
      ),
    );
    await placeOrderEvent.handler(placed, ctxFor(base, fakeDb(null)));
    expect(t.calls).toHaveLength(0);
  });

  it('consent is read from the order, not from the event payload (a stale or forged payload cannot grant it)', async () => {
    const t = await fakeTikTok({ status: 200, json: { code: 0 } });
    await placeOrderEvent.handler(
      { ...placed, marketingConsent: true },
      ctxFor({ apiBase: t.url }, fakeDb({ email: 'a@b.co', consent: { marketing: false } })),
    );
    expect(t.calls).toHaveLength(0);
  });

  it('a transient failure throws (so the observer retries); a rejection is dropped and not recorded', async () => {
    const down = await fakeTikTok({ status: 503, json: {} });
    const db1 = fakeDb({ email: 'a@b.co', consent: { marketing: true } });
    await expect(
      placeOrderEvent.handler(placed, ctxFor({ apiBase: down.url }, db1)),
    ).rejects.toThrow(/503/);
    expect(db1.sent.size).toBe(0);
    server?.close();
    const rejected = await fakeTikTok({ status: 400, json: { code: 40002, message: 'bad pixel' } });
    const db2 = fakeDb({ email: 'a@b.co', consent: { marketing: true } });
    await expect(
      placeOrderEvent.handler(placed, ctxFor({ apiBase: rejected.url }, db2)),
    ).resolves.toBeUndefined();
    expect(db2.sent.size).toBe(0);
  });

  it('CompletePayment uses its own event id', async () => {
    const t = await fakeTikTok({ status: 200, json: { code: 0 } });
    const db = fakeDb({ email: 'a@b.co', consent: { marketing: true } });
    await paymentEvent.handler(
      {
        paymentId: 'pay-1',
        orderId: placed.orderId,
        amount: { amount: 2599n, currency: 'AUD' },
        gateway: 'stripe',
      },
      ctxFor({ apiBase: t.url }, db),
    );
    expect(t.calls[0]!.body.data[0]).toMatchObject({
      event: 'CompletePayment',
      event_id: 'payment-pay-1',
    });
  });
});
