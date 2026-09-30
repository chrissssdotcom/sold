import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Money } from '@sold/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayError, WebhookVerificationError } from '../gateway';
import {
  StripeGateway,
  signStripePayload,
  translateStripeEvent,
  verifyStripeSignature,
} from './stripe';

const SECRET = 'whsec_test_secret';
const NOW = 1_800_000_000;

const event = (type: string, object: Record<string, unknown>, id = 'evt_1') =>
  JSON.stringify({ id, type, data: { object } });

describe('verifyStripeSignature', () => {
  const body = event('payment_intent.succeeded', { id: 'pi_1' });
  const verify = (header: string | null, opts: { nowSeconds?: number; secret?: string } = {}) =>
    verifyStripeSignature({
      rawBody: body,
      header,
      secret: opts.secret ?? SECRET,
      toleranceSeconds: 300,
      nowSeconds: opts.nowSeconds ?? NOW,
    });

  it('accepts a correctly signed body', () => {
    expect(() => verify(signStripePayload(SECRET, body, NOW))).not.toThrow();
  });

  it('accepts when any of several v1 signatures matches (secret rotation)', () => {
    const good = signStripePayload(SECRET, body, NOW);
    const withOld = `${good.split(',')[0]},v1=${'0'.repeat(64)},${good.split(',')[1]}`;
    expect(() => verify(withOld)).not.toThrow();
  });

  it.each([
    ['missing header', null],
    ['garbage', 'nonsense'],
    ['no signature', `t=${NOW}`],
    ['no timestamp', `v1=${'a'.repeat(64)}`],
    ['non-hex signature', `t=${NOW},v1=zzzz`],
    ['short signature', `t=${NOW},v1=abcd`],
    ['wrong secret', signStripePayload('whsec_other', body, NOW)],
  ])('rejects %s', (_name, header) => {
    expect(() => verify(header)).toThrow(WebhookVerificationError);
  });

  it('rejects a tampered body and a replayed old timestamp', () => {
    const header = signStripePayload(SECRET, body, NOW);
    expect(() =>
      verifyStripeSignature({
        rawBody: body + ' ',
        header,
        secret: SECRET,
        toleranceSeconds: 300,
        nowSeconds: NOW,
      }),
    ).toThrow(WebhookVerificationError);
    expect(() => verify(header, { nowSeconds: NOW + 301 })).toThrow(/tolerance/);
    expect(() => verify(header, { nowSeconds: NOW + 300 })).not.toThrow();
  });
});

describe('translateStripeEvent', () => {
  const t = (type: string, object: Record<string, unknown>) =>
    translateStripeEvent(JSON.parse(event(type, object)));

  it('maps payment intent lifecycle events', () => {
    expect(
      t('payment_intent.succeeded', {
        id: 'pi_1',
        amount: 1000,
        amount_received: 1000,
        currency: 'aud',
      }),
    ).toEqual([
      {
        eventId: 'evt_1',
        type: 'payment.captured',
        gatewayRef: 'pi_1',
        amount: Money.of(1000n, 'AUD'),
      },
    ]);
    expect(
      t('payment_intent.payment_failed', {
        id: 'pi_1',
        last_payment_error: { code: 'card_declined' },
      }),
    ).toEqual([
      { eventId: 'evt_1', type: 'payment.failed', gatewayRef: 'pi_1', code: 'card_declined' },
    ]);
    expect(t('payment_intent.canceled', { id: 'pi_1' })[0]?.type).toBe('payment.voided');
    expect(t('payment_intent.requires_action', { id: 'pi_1' })[0]?.type).toBe(
      'payment.requires_action',
    );
    expect(t('payment_intent.amount_capturable_updated', { id: 'pi_1' })[0]?.type).toBe(
      'payment.authorized',
    );
  });

  it('maps refund events and waits on pending ones', () => {
    const base = { id: 're_1', payment_intent: 'pi_1', amount: 250, currency: 'jpy' };
    expect(t('refund.updated', { ...base, status: 'succeeded' })).toEqual([
      {
        eventId: 'evt_1',
        type: 'refund.succeeded',
        gatewayRef: 'pi_1',
        refundRef: 're_1',
        amount: Money.of(250n, 'JPY'),
      },
    ]);
    expect(t('refund.updated', { ...base, status: 'pending' })).toEqual([]);
    expect(t('refund.updated', { ...base, status: 'failed' })[0]?.type).toBe('refund.failed');
    expect(t('refund.failed', { ...base })[0]?.type).toBe('refund.failed');
  });

  it('ignores unknown events and malformed objects instead of throwing', () => {
    expect(t('customer.created', { id: 'cus_1' })).toEqual([]);
    expect(t('payment_intent.succeeded', {})).toEqual([]);
    expect(t('payment_intent.succeeded', { id: 'pi', amount: 1.5, currency: 'aud' })).toEqual([]);
  });
});

describe('StripeGateway over a local fake Stripe API', () => {
  let server: Server;
  let base: string;
  const seen: { path: string; headers: IncomingMessage['headers']; body: URLSearchParams }[] = [];
  let respond: (path: string) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {},
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          path: req.url ?? '',
          headers: req.headers,
          body: new URLSearchParams(Buffer.concat(chunks).toString()),
        });
        const r = respond(req.url ?? '');
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const gw = (over: object = {}) =>
    new StripeGateway({
      secretKey: 'sk_test_x',
      webhookSecret: SECRET,
      apiBase: base,
      now: () => NOW * 1000,
      ...over,
    });
  const req = (amount: Money) => ({
    paymentId: 'pay_1',
    orderId: 'ord_1',
    orderNumber: '1001',
    amount,
    customerEmail: 'a@b.co',
  });

  it('creates a payment intent with form encoding, auth and the idempotency key', async () => {
    respond = () => ({
      status: 200,
      body: { id: 'pi_9', status: 'requires_payment_method', client_secret: 'cs_1' },
    });
    const r = await gw().createPayment(req(Money.of(1999n, 'AUD')));
    expect(r).toEqual({ gatewayRef: 'pi_9', status: 'pending', clientSecret: 'cs_1' });
    const call = seen.at(-1)!;
    expect(call.path).toBe('/v1/payment_intents');
    expect(call.headers.authorization).toBe('Bearer sk_test_x');
    expect(call.headers['idempotency-key']).toBe('pay_1');
    expect(call.body.get('amount')).toBe('1999');
    expect(call.body.get('currency')).toBe('aud');
    expect(call.body.get('metadata[order_id]')).toBe('ord_1');
  });

  it('sends zero-decimal amounts as-is (JPY) and refuses three-decimal amounts not divisible by 10', async () => {
    respond = () => ({ status: 200, body: { id: 'pi_j', status: 'succeeded' } });
    await gw().createPayment(req(Money.of(5000n, 'JPY')));
    expect(seen.at(-1)!.body.get('amount')).toBe('5000');
    const before = seen.length;
    await expect(gw().createPayment(req(Money.of(1234n, 'KWD')))).rejects.toMatchObject({
      retryable: false,
      code: 'unsupported_amount',
    });
    expect(seen.length).toBe(before); // refused locally: nothing sent
    await expect(gw().createPayment(req(Money.of(1230n, 'KWD')))).resolves.toBeDefined();
  });

  it('classifies errors: declines are final, 429/5xx/network are retryable', async () => {
    respond = () => ({
      status: 402,
      body: { error: { code: 'card_declined', message: 'Declined' } },
    });
    await expect(gw().createPayment(req(Money.of(100n, 'AUD')))).rejects.toMatchObject({
      retryable: false,
      code: 'card_declined',
    });
    respond = () => ({ status: 429, body: {} });
    await expect(gw().createPayment(req(Money.of(100n, 'AUD')))).rejects.toMatchObject({
      retryable: true,
    });
    respond = () => ({ status: 503, body: 'oops' });
    await expect(gw().createPayment(req(Money.of(100n, 'AUD')))).rejects.toMatchObject({
      retryable: true,
    });
    await expect(
      gw({ apiBase: 'http://127.0.0.1:1', timeoutMs: 500 }).createPayment(
        req(Money.of(100n, 'AUD')),
      ),
    ).rejects.toMatchObject({ retryable: true, code: 'network_error' });
    expect(new GatewayError('x', true)).toBeInstanceOf(Error);
  });

  it('refunds with the idempotency key and maps status', async () => {
    respond = () => ({ status: 200, body: { id: 're_1', status: 'succeeded' } });
    const r = await gw().refund({
      gatewayRef: 'pi_9',
      amount: Money.of(500n, 'AUD'),
      idempotencyKey: 'ref_1',
      reason: 'damaged',
    });
    expect(r).toEqual({ refundRef: 're_1', status: 'succeeded' });
    const call = seen.at(-1)!;
    expect(call.path).toBe('/v1/refunds');
    expect(call.headers['idempotency-key']).toBe('ref_1');
    expect(call.body.get('payment_intent')).toBe('pi_9');
    expect(call.body.get('amount')).toBe('500');
    respond = () => ({ status: 200, body: { id: 're_2', status: 'pending' } });
    expect(
      (
        await gw().refund({
          gatewayRef: 'pi_9',
          amount: Money.of(1n, 'AUD'),
          idempotencyKey: 'k',
          reason: '',
        })
      ).status,
    ).toBe('pending');
  });

  it('parseWebhook verifies then translates', () => {
    const body = event('payment_intent.succeeded', {
      id: 'pi_1',
      amount_received: 700,
      currency: 'aud',
    });
    const headers = new Headers({ 'stripe-signature': signStripePayload(SECRET, body, NOW) });
    expect(gw().parseWebhook(body, headers)).toHaveLength(1);
    expect(() => gw().parseWebhook(body, new Headers())).toThrow(WebhookVerificationError);
    expect(() =>
      gw().parseWebhook(
        'not json',
        new Headers({ 'stripe-signature': signStripePayload(SECRET, 'not json', NOW) }),
      ),
    ).toThrow(/Malformed/);
  });
});
