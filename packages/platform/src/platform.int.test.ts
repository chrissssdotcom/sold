import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { openMigrated } from '@sold/commerce/testing';
import { EnvelopeCrypto, rootKeyFromBase64 } from '@sold/core/crypto';
import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from './api-keys';
import { WebhookConfigError, WebhookService, sign } from './webhooks';

let testDb: TestDatabase;
let db: Db;
const crypto = new EnvelopeCrypto(rootKeyFromBase64(randomBytes(32).toString('base64')));
const hooks = new WebhookService(crypto, { allowPrivate: true });
let n = 0;
const eid = () => `evt-${++n}-${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 10);
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

describe('API keys', () => {
  it('creates a key shown once; only a hash is stored; verifies with its scopes', async () => {
    const { token, record } = await createApiKey(db.primary, {
      name: 'ERP',
      scopes: ['catalog:read', 'orders:read'],
      createdBy: 'test',
    });
    expect(token).toMatch(/^sk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    const stored = (
      await db.primary.execute<{ secret_hash: string }>(
        sql`SELECT secret_hash FROM api_keys WHERE id = ${record.id}`,
      )
    ).rows[0]!;
    expect(stored.secret_hash).not.toContain(token.split('_')[2]!);
    const ok = await verifyApiKey(db.primary, token);
    expect(ok).toMatchObject({
      id: record.id,
      name: 'ERP',
      scopes: ['catalog:read', 'orders:read'],
    });
    expect(JSON.stringify(await listApiKeys(db.primary))).not.toContain(token.split('_')[2]!);
  });

  it('rejects wrong secrets, malformed tokens, unknown prefixes, revoked and expired keys (all as null)', async () => {
    const { token, record } = await createApiKey(db.primary, {
      name: 'k2',
      scopes: ['catalog:read'],
      createdBy: 't',
    });
    const [, prefix, secret] = token.split('_') as [string, string, string];
    for (const bad of [
      `sk_${prefix}_${'A'.repeat(43)}`,
      `sk_00000000_${secret}`,
      'sk_nope',
      '',
      'Bearer x',
      `${token}x`,
      token.toUpperCase(),
    ])
      expect(await verifyApiKey(db.primary, bad), bad).toBeNull();
    expect(await verifyApiKey(db.primary, null)).toBeNull();
    expect(await revokeApiKey(db.primary, record.id)).toBe(true);
    expect(await revokeApiKey(db.primary, record.id)).toBe(false);
    expect(await verifyApiKey(db.primary, token)).toBeNull();
    const expired = await createApiKey(db.primary, {
      name: 'old',
      scopes: ['catalog:read'],
      createdBy: 't',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await verifyApiKey(db.primary, expired.token)).toBeNull();
  });
});

describe('webhooks', () => {
  let server: Server;
  let url: string;
  const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let respond = 200;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: raw });
        res.writeHead(respond).end('ignored body');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  });
  afterAll(() => void server.close());

  const due = (id: string) =>
    db.primary.execute(
      sql`UPDATE webhook_deliveries SET available_at = now() - interval '1 second' WHERE endpoint_id = ${id}`,
    );
  const rowsOf = async (id: string) =>
    (
      await db.primary.execute<{ status: string; attempts: number; last_status: number | null }>(
        sql`SELECT status, attempts, last_status FROM webhook_deliveries WHERE endpoint_id = ${id} ORDER BY created_at`,
      )
    ).rows;

  it('refuses unsafe endpoints in a strict environment', async () => {
    const strict = new WebhookService(crypto, { allowPrivate: false });
    for (const u of ['http://example.com/x', 'https://169.254.169.254/x', 'https://localhost/x'])
      await expect(
        strict.createEndpoint(db.primary, { url: u, events: ['order.placed'], createdBy: 't' }),
        u,
      ).rejects.toBeInstanceOf(WebhookConfigError);
    await expect(
      strict.createEndpoint(db.primary, {
        url: 'https://hooks.example.com/x',
        events: [],
        createdBy: 't',
      }),
    ).rejects.toBeInstanceOf(WebhookConfigError);
  });

  it('delivers a signed event once; the signature verifies with the secret shown at creation; redelivered events queue nothing new', async () => {
    received.length = 0;
    const { id, secret } = await hooks.createEndpoint(db.primary, {
      url,
      events: ['order.placed'],
      createdBy: 't',
    });
    const ev = {
      eventId: eid(),
      eventType: 'order.placed',
      payload: { orderId: 'o1', total: { amount: 2599n, currency: 'AUD' } },
    };
    expect(await hooks.enqueue(db.primary, ev)).toBe(1);
    expect(await hooks.enqueue(db.primary, ev)).toBe(0); // at-least-once relay: same event again
    expect(
      await hooks.enqueue(db.primary, { ...ev, eventId: eid(), eventType: 'order.status_changed' }),
    ).toBe(0); // not subscribed
    const r = await hooks.deliverDue(db.primary);
    expect(r.delivered).toBeGreaterThanOrEqual(1);
    const got = received.find((x) => x.headers['sold-event'] === 'order.placed')!;
    const parsed = JSON.parse(got.body) as {
      id: string;
      type: string;
      data: { total: { amount: string } };
    };
    expect(parsed).toMatchObject({ id: ev.eventId, type: 'order.placed' });
    expect(parsed.data.total.amount).toBe('2599'); // bigint-safe on the wire
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(got.headers['sold-signature']))!;
    expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${got.body}`).digest('hex'));
    expect(String(got.headers['sold-signature'])).toBe(sign(secret, got.body, Number(t)));
    expect((await rowsOf(id))[0]).toMatchObject({
      status: 'delivered',
      attempts: 1,
      last_status: 200,
    });
    // The secret is not stored in the clear.
    const enc = (
      await db.primary.execute<{ secret_enc: string }>(
        sql`SELECT secret_enc FROM webhook_endpoints WHERE id = ${id}`,
      )
    ).rows[0]!;
    expect(enc.secret_enc).not.toContain(secret);
  });

  it('retries 5xx with backoff, gives up on 4xx immediately, and a disabled endpoint receives nothing', async () => {
    const { id } = await hooks.createEndpoint(db.primary, {
      url,
      events: ['payment.captured'],
      createdBy: 't',
    });
    respond = 503;
    await hooks.enqueue(db.primary, { eventId: eid(), eventType: 'payment.captured', payload: {} });
    await hooks.deliverDue(db.primary);
    expect((await rowsOf(id))[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_status: 503,
    });
    const next = (
      await db.primary.execute<{ available_at: string }>(
        sql`SELECT available_at FROM webhook_deliveries WHERE endpoint_id = ${id}`,
      )
    ).rows[0]!;
    expect(new Date(next.available_at).getTime()).toBeGreaterThan(Date.now() + 5_000);
    respond = 200;
    await due(id);
    await hooks.deliverDue(db.primary);
    expect((await rowsOf(id))[0]).toMatchObject({ status: 'delivered', attempts: 2 });

    respond = 400;
    await hooks.enqueue(db.primary, { eventId: eid(), eventType: 'payment.captured', payload: {} });
    await hooks.deliverDue(db.primary);
    expect((await rowsOf(id))[1]).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_status: 400,
    });

    respond = 200;
    await hooks.setActive(db.primary, id, false);
    expect(
      await hooks.enqueue(db.primary, {
        eventId: eid(),
        eventType: 'payment.captured',
        payload: {},
      }),
    ).toBe(0);
  });

  it('a strict service refuses to connect to a private destination even if the row already exists (defence at connect time)', async () => {
    const { id } = await hooks.createEndpoint(db.primary, {
      url,
      events: ['page.published'],
      createdBy: 't',
    });
    await hooks.enqueue(db.primary, { eventId: eid(), eventType: 'page.published', payload: {} });
    const strict = new WebhookService(crypto, { allowPrivate: false });
    await strict.deliverDue(db.primary);
    const [row] = await rowsOf(id);
    expect(row!.status).toBe('pending'); // refused, will retry (and keep being refused), nothing was sent
    expect(received.filter((r) => r.headers['sold-event'] === 'page.published')).toHaveLength(0);
  });

  it('many workers deliver each event exactly once', async () => {
    const { id } = await hooks.createEndpoint(db.primary, {
      url,
      events: ['bulk.test'],
      createdBy: 't',
    });
    received.length = 0;
    for (let i = 0; i < 30; i++)
      await hooks.enqueue(db.primary, { eventId: eid(), eventType: 'bulk.test', payload: { i } });
    await Promise.all(Array.from({ length: 6 }, () => hooks.deliverDue(db.primary, { batch: 8 })));
    await hooks.deliverDue(db.primary, { batch: 50 });
    const ids = received
      .filter((r) => r.headers['sold-event'] === 'bulk.test')
      .map((r) => String(r.headers['sold-delivery']));
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect((await rowsOf(id)).every((r) => r.status === 'delivered')).toBe(true);
  });
});
