import type { DbOrTx } from '@sold/commerce';
import { eq, schema, sql, type PrimaryDb } from '@sold/db';
import { EmailTransportError, type EmailTransport } from './transport';
import { isTemplate, render, type Site, type TemplateName } from './templates';

const { emailSuppressions } = schema;

export interface EnqueueInput {
  /** One logical email = one key. Typically `<event id>:<template>`. A second enqueue with the same key is a no-op. */
  dedupeKey: string;
  template: TemplateName;
  to: string;
  data: unknown;
  locale?: string;
  /** Delay before the first attempt (lifecycle emails). */
  delaySeconds?: number;
}

export interface NotificationOptions {
  site: Site;
  from: string;
  /** Give up after this many failed attempts. */
  maxAttempts?: number;
  /** How long a claimed row stays leased to one worker; a crashed worker's rows are retried after this. */
  leaseSeconds?: number;
}

export interface DeliveryReport {
  sent: number;
  retried: number;
  failed: number;
  suppressed: number;
}

const normaliseEmail = (e: string) => e.trim().toLowerCase();
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

/**
 * Durable email: `enqueue` is cheap and idempotent (call it inside the transaction that caused the email, or from an
 * at-least-once event consumer); `deliverDue` is what a worker runs. Delivery is **at least once**: if a worker dies
 * between the provider accepting a message and us recording it, the lease expires and the message is sent again. The
 * `Message-ID`/idempotency key is stable so providers and mail clients can recognise the duplicate.
 */
export class NotificationService {
  private readonly maxAttempts: number;
  private readonly leaseSeconds: number;
  constructor(private readonly opts: NotificationOptions) {
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.leaseSeconds = opts.leaseSeconds ?? 300;
  }

  /** Returns true if a new email was queued, false if this key already existed (or the address is unusable). */
  async enqueue(db: DbOrTx, input: EnqueueInput): Promise<boolean> {
    const to = normaliseEmail(input.to);
    if (!EMAIL.test(to) || to.length > 254) return false;
    // Fail at enqueue, not at 3 a.m. in the worker: the data must satisfy the template.
    render(input.template, input.data, this.opts.site);
    const res = await db.execute(sql`
      INSERT INTO notifications (dedupe_key, template, to_email, locale, data, available_at)
      VALUES (${input.dedupeKey}, ${input.template}, ${to}, ${input.locale ?? 'en-au'},
              ${JSON.stringify(input.data)}::jsonb, now() + make_interval(secs => ${input.delaySeconds ?? 0}))
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`);
    return res.rows.length > 0;
  }

  async suppress(db: DbOrTx, email: string, reason: string): Promise<void> {
    await db
      .insert(emailSuppressions)
      .values({ email: normaliseEmail(email), reason: reason.slice(0, 200) })
      .onConflictDoNothing();
  }

  async unsuppress(db: DbOrTx, email: string): Promise<void> {
    await db.delete(emailSuppressions).where(eq(emailSuppressions.email, normaliseEmail(email)));
  }

  /** Claim up to `batch` due rows (SKIP LOCKED, so many workers can run) and send them. */
  async deliverDue(
    db: PrimaryDb,
    transport: EmailTransport,
    opts: { batch?: number } = {},
  ): Promise<DeliveryReport> {
    const report: DeliveryReport = { sent: 0, retried: 0, failed: 0, suppressed: 0 };
    const claimed = await db.execute<{
      id: string;
      dedupe_key: string;
      template: string;
      to_email: string;
      data: unknown;
      attempts: number;
    }>(sql`
      UPDATE notifications SET status = 'sending', attempts = attempts + 1,
             available_at = now() + make_interval(secs => ${this.leaseSeconds})
      WHERE id IN (
        SELECT id FROM notifications
        WHERE status IN ('queued', 'sending') AND available_at <= now()
        ORDER BY available_at LIMIT ${opts.batch ?? 20} FOR UPDATE SKIP LOCKED)
      RETURNING id, dedupe_key, template, to_email, data, attempts`);

    for (const row of claimed.rows) {
      const [blocked] = await db
        .select({ email: emailSuppressions.email })
        .from(emailSuppressions)
        .where(eq(emailSuppressions.email, row.to_email));
      if (blocked) {
        await this.finish(db, row.id, 'suppressed', { error: 'address suppressed' });
        report.suppressed += 1;
        continue;
      }
      try {
        if (!isTemplate(row.template))
          throw new EmailTransportError(`unknown template ${row.template}`, true);
        const out = render(row.template, row.data, this.opts.site);
        const r = await transport.send({
          from: this.opts.from,
          to: row.to_email,
          subject: out.subject,
          html: out.html,
          text: out.text,
          idempotencyKey: row.dedupe_key,
        });
        await this.finish(db, row.id, 'sent', { providerId: r.providerId });
        report.sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'send failed';
        const permanent = error instanceof EmailTransportError && error.permanent;
        if (permanent || row.attempts >= this.maxAttempts) {
          await this.finish(db, row.id, 'failed', { error: message });
          report.failed += 1;
        } else {
          // 30 s, 1 m, 2 m, ... capped at 1 h, with jitter so a provider outage does not become a thundering herd.
          const delay = Math.min(3600, 30 * 2 ** (row.attempts - 1)) * (0.8 + Math.random() * 0.4);
          await db.execute(sql`
            UPDATE notifications SET status = 'queued', last_error = ${message.slice(0, 500)},
                   available_at = now() + make_interval(secs => ${delay}) WHERE id = ${row.id}`);
          report.retried += 1;
        }
      }
    }
    return report;
  }

  private async finish(
    db: PrimaryDb,
    id: string,
    status: 'sent' | 'failed' | 'suppressed',
    info: { providerId?: string; error?: string },
  ): Promise<void> {
    await db.execute(sql`
      UPDATE notifications SET status = ${status},
             sent_at = ${status === 'sent' ? sql`now()` : sql`NULL`},
             provider_id = ${info.providerId ?? null}, last_error = ${info.error?.slice(0, 500) ?? null}
      WHERE id = ${id}`);
  }

  /** Counts for the admin dashboard and alerting: anything `failed` or long-`queued` needs a person. */
  async stats(
    db: DbOrTx,
  ): Promise<{ queued: number; failed: number; oldestQueuedSeconds: number | null }> {
    const r = await db.execute<{ queued: number; failed: number; oldest: number | null }>(sql`
      SELECT count(*) FILTER (WHERE status IN ('queued','sending'))::int AS queued,
             count(*) FILTER (WHERE status = 'failed')::int AS failed,
             extract(epoch FROM now() - min(created_at) FILTER (WHERE status IN ('queued','sending')))::int AS oldest
      FROM notifications`);
    const row = r.rows[0];
    return {
      queued: row?.queued ?? 0,
      failed: row?.failed ?? 0,
      oldestQueuedSeconds: row?.oldest ?? null,
    };
  }
}
