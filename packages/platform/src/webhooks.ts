import { createHmac, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { DbOrTx } from '@sold/commerce';
import type { EnvelopeCrypto } from '@sold/core/crypto';
import { eq, schema, sql, type PrimaryDb } from '@sold/db';
import { isForbiddenAddress, validateWebhookUrl, type UrlPolicy } from './ssrf';

const { webhookEndpoints } = schema;

export interface EndpointInput {
  url: string;
  events: string[];
  description?: string;
  createdBy: string;
}

/** `Sold-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<body>">`. Receivers should reject old timestamps (replay) and compare in constant time. */
export function sign(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export class WebhookService {
  constructor(
    private readonly crypto: EnvelopeCrypto,
    private readonly policy: UrlPolicy,
    private readonly fetchImpl: DeliverFn = deliverHttp,
  ) {}

  /** Returns the signing secret ONCE; it is stored encrypted and never shown again. */
  async createEndpoint(db: DbOrTx, input: EndpointInput): Promise<{ id: string; secret: string }> {
    const bad = validateWebhookUrl(input.url, this.policy);
    if (bad) throw new WebhookConfigError(`url ${bad}`);
    if (input.events.length === 0 || input.events.length > 30)
      throw new WebhookConfigError('choose 1 to 30 events');
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const [row] = await db
      .insert(webhookEndpoints)
      .values({
        url: input.url,
        events: [...new Set(input.events)],
        secretEnc: this.crypto.encrypt(secret, 'webhook-secret'),
        description: input.description ?? '',
        createdBy: input.createdBy,
      })
      .returning({ id: webhookEndpoints.id });
    if (!row) throw new Error('endpoint insert failed');
    return { id: row.id, secret };
  }

  /**
   * Queue one delivery per active endpoint subscribed to the event. Idempotent per (endpoint, event id): the outbox relay is
   * at-least-once, so the same event can arrive repeatedly and still queues exactly one delivery per endpoint.
   */
  async enqueue(
    db: DbOrTx,
    event: { eventId: string; eventType: string; payload: unknown; createdAt?: Date },
  ): Promise<number> {
    const body = {
      id: event.eventId,
      type: event.eventType,
      createdAt: (event.createdAt ?? new Date()).toISOString(),
      data: event.payload,
    };
    const res = await db.execute(sql`
      INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload)
      SELECT e.id, ${event.eventId}, ${event.eventType}, ${JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}::jsonb
      FROM webhook_endpoints e WHERE e.active AND ${event.eventType} = ANY(e.events)
      ON CONFLICT (endpoint_id, event_id) DO NOTHING RETURNING id`);
    return res.rows.length;
  }

  /** Claim due deliveries (SKIP LOCKED, leased) and send them. At-least-once: receivers dedupe on the `Sold-Delivery`/event id. */
  async deliverDue(
    db: PrimaryDb,
    opts: { batch?: number; maxAttempts?: number } = {},
  ): Promise<{ delivered: number; retried: number; failed: number }> {
    const max = opts.maxAttempts ?? 10;
    const report = { delivered: 0, retried: 0, failed: 0 };
    const claimed = await db.execute<{
      id: string;
      event_id: string;
      event_type: string;
      payload: unknown;
      attempts: number;
      url: string;
      secret_enc: string;
      active: boolean;
    }>(sql`
      UPDATE webhook_deliveries d SET status = 'delivering', attempts = d.attempts + 1, available_at = now() + interval '2 minutes'
      FROM webhook_endpoints e
      WHERE d.endpoint_id = e.id AND d.id IN (
        SELECT id FROM webhook_deliveries WHERE status IN ('pending','delivering') AND available_at <= now()
        ORDER BY available_at LIMIT ${opts.batch ?? 20} FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.event_id, d.event_type, d.payload, d.attempts, e.url, e.secret_enc, e.active`);
    for (const row of claimed.rows) {
      if (!row.active) {
        await this.finish(db, row.id, 'failed', null, 'endpoint disabled');
        report.failed += 1;
        continue;
      }
      const body = JSON.stringify(row.payload);
      const t = Math.floor(Date.now() / 1000);
      let status: number | null = null;
      let error: string | null = null;
      try {
        const secret = this.crypto.decrypt(row.secret_enc, 'webhook-secret');
        const r = await this.fetchImpl(
          row.url,
          body,
          {
            'content-type': 'application/json',
            'user-agent': 'Sold-Webhooks/1',
            'sold-event': row.event_type,
            'sold-delivery': row.id,
            'sold-signature': sign(secret, body, t),
          },
          this.policy,
        );
        status = r.status;
        if (r.status >= 200 && r.status < 300) {
          await this.finish(db, row.id, 'delivered', status, null);
          report.delivered += 1;
          continue;
        }
        error = `HTTP ${r.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : 'delivery failed';
      }
      // 4xx other than 408/429 means the receiver refused it: retrying the same bytes cannot help.
      const permanent =
        status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent || row.attempts >= max) {
        await this.finish(db, row.id, 'failed', status, error);
        report.failed += 1;
      } else {
        const delay =
          Math.min(6 * 3600, 20 * 3 ** (row.attempts - 1)) * (0.8 + Math.random() * 0.4);
        await db.execute(
          sql`UPDATE webhook_deliveries SET status = 'pending', last_status = ${status}, last_error = ${error?.slice(0, 300) ?? null}, available_at = now() + make_interval(secs => ${delay}) WHERE id = ${row.id}`,
        );
        report.retried += 1;
      }
    }
    return report;
  }

  private async finish(
    db: PrimaryDb,
    id: string,
    status: 'delivered' | 'failed',
    http: number | null,
    error: string | null,
  ) {
    await db.execute(
      sql`UPDATE webhook_deliveries SET status = ${status}, last_status = ${http}, last_error = ${error?.slice(0, 300) ?? null}, delivered_at = ${status === 'delivered' ? sql`now()` : sql`NULL`} WHERE id = ${id}`,
    );
  }

  async setActive(db: DbOrTx, id: string, active: boolean): Promise<void> {
    await db.update(webhookEndpoints).set({ active }).where(eq(webhookEndpoints.id, id));
  }
}

export class WebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookConfigError';
  }
}

export type DeliverFn = (
  url: string,
  body: string,
  headers: Record<string, string>,
  policy: UrlPolicy,
) => Promise<{ status: number }>;

/**
 * POST with the SSRF checks applied at CONNECT time: the hostname is resolved by our own `lookup`, which refuses private,
 * loopback, link-local and metadata addresses, so a DNS name that resolved safely at registration and later points inward
 * (rebinding) is still refused. No redirects are followed, the response body is discarded, and the call has a hard timeout.
 */
export const deliverHttp: DeliverFn = (rawUrl, body, headers, policy) =>
  new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const bad = validateWebhookUrl(rawUrl, policy);
    if (bad) return reject(new Error(`url ${bad}`));
    const guarded: LookupFunction = (hostname, options, callback) => {
      lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return (callback as (e: Error | null) => void)(err);
        const list = Array.isArray(addresses)
          ? addresses
          : [{ address: addresses as unknown as string, family: 4 }];
        const ok = list.filter((a) => policy.allowPrivate || !isForbiddenAddress(a.address));
        if (ok.length === 0)
          return (callback as (e: Error | null) => void)(
            new Error('destination resolves to a private or reserved address'),
          );
        const first = ok[0]!;
        if (options.all) return (callback as unknown as (e: null, a: typeof ok) => void)(null, ok);
        return (callback as unknown as (e: null, a: string, f: number) => void)(
          null,
          first.address,
          first.family,
        );
      });
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
        lookup: guarded,
        timeout: 10_000,
      },
      (res) => {
        res.resume(); // never read the receiver's body
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out after 10 s')));
    req.on('error', reject);
    req.end(body);
  });
