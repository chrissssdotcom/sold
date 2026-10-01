/** Pure helpers for the Events API payload. No I/O: the observer hashes with `node:crypto` and sends. */
import { createHash } from 'node:crypto';

/** TikTok requires identifiers to be normalised then SHA-256 hashed (lowercase hex). */
export const hashEmail = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** Minor units -> a decimal number of major units, using the currency's own exponent. Display/analytics only. */
export function toMajor(amountMinor: string | bigint, currency: string): number {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const n = BigInt(amountMinor);
  const div = 10n ** BigInt(digits);
  return Number(n / div) + Number(n % div) / Number(div);
}

export interface ConversionInput {
  event: 'PlaceAnOrder' | 'CompletePayment';
  eventId: string;
  occurredAt: Date;
  email: string;
  currency: string;
  amountMinor: string | bigint;
  pageUrl?: string;
}

export function buildPayload(pixelCode: string, c: ConversionInput, testEventCode?: string) {
  return {
    event_source: 'web',
    event_source_id: pixelCode,
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
    data: [
      {
        event: c.event,
        event_time: Math.floor(c.occurredAt.getTime() / 1000),
        event_id: c.eventId,
        user: { email: hashEmail(c.email) },
        properties: {
          currency: c.currency,
          value: toMajor(c.amountMinor, c.currency),
          content_type: 'product',
        },
        ...(c.pageUrl ? { page: { url: c.pageUrl } } : {}),
      },
    ],
  };
}
