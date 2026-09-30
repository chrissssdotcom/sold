import { defineExtension, type EventName } from '@sold/extension-sdk';
import { describe, expect, it } from 'vitest';
import { EventBus, observerQueue, type ObserverJob } from './event-bus';
import type { LoadedExtension } from './load-order';

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

function ext(
  name: string,
  index: number,
  observers: { event: EventName; name: string; handler: (p: never, c: never) => Promise<void> }[],
): LoadedExtension {
  const manifest = defineExtension({
    name,
    version: '1.0.0',
    requires: { base: '*' },
    performance: { hotPath: false },
    observers: observers as never,
  });
  return { manifest, origin: 'instance', index };
}

function setup(
  extensions: LoadedExtension[],
  dispatch?: (job: ObserverJob, key: string) => Promise<void>,
) {
  const dispatched: { job: ObserverJob; key: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  const bus = new EventBus({
    extensions,
    dispatcher: { dispatch: dispatch ?? (async (job, key) => void dispatched.push({ job, key })) },
    contextFor: (extension, signal) => ({
      extension,
      signal,
      log: noopLog,
      settings: { get: async () => ({}) },
      db: {} as never,
      queue: { enqueue: async () => null },
    }),
    onLog: (_l, f) => logs.push(f),
    observerTimeoutMs: 50,
  });
  return { bus, dispatched, logs };
}

const order = {
  orderId: 'o1',
  orderNumber: '1001',
  customerId: null,
  total: { amount: 12_345n, currency: 'AUD' },
  placedAt: new Date('2026-09-30T00:00:00Z'),
};

describe('EventBus', () => {
  it('names the per-extension queue', () =>
    expect(observerQueue('loyalty')).toBe('ext.loyalty.events'));

  it('publishes nothing when nobody subscribes', async () => {
    const { bus, dispatched } = setup([]);
    expect(await bus.publish('order.placed', order)).toMatchObject({ dispatched: 0, failed: 0 });
    expect(dispatched).toEqual([]);
  });

  it('enqueues one delivery per observer with a stable per-observer idempotency key', async () => {
    const h = async () => undefined;
    const { bus, dispatched } = setup([
      ext('loyalty', 0, [{ event: 'order.placed', name: 'award', handler: h }]),
      ext('crm', 1, [
        { event: 'order.placed', name: 'sync', handler: h },
        { event: 'cart.updated', name: 'other', handler: h },
      ]),
    ]);
    const res = await bus.publish('order.placed', order, { eventId: 'evt-1' });
    expect(res).toEqual({ eventId: 'evt-1', dispatched: 2, failed: 0 });
    expect(dispatched.map((d) => d.key)).toEqual(['evt-1:loyalty:award', 'evt-1:crm:sync']);
    // Republishing the same event id yields the same keys, so a queue that dedupes on key makes redelivery harmless.
    await bus.publish('order.placed', order, { eventId: 'evt-1' });
    expect(dispatched.slice(2).map((d) => d.key)).toEqual(dispatched.slice(0, 2).map((d) => d.key));
  });

  it('never throws or blocks the caller when dispatch fails; reports and logs it', async () => {
    const h = async () => undefined;
    const { bus, logs } = setup(
      [ext('loyalty', 0, [{ event: 'order.placed', name: 'award', handler: h }])],
      async () => {
        throw new Error('queue down');
      },
    );
    const res = await bus.publish('order.placed', order);
    expect(res).toMatchObject({ dispatched: 0, failed: 1 });
    expect(logs[0]).toMatchObject({ extension: 'loyalty', observer: 'award' });
  });

  it('delivers a decoded payload (bigint and Date survive) to the handler with the event id and attempt', async () => {
    let seen:
      | { payload: unknown; ctx: { eventId: string; attempt: number; extension: string } }
      | undefined;
    const { bus, dispatched } = setup([
      ext('loyalty', 0, [
        {
          event: 'order.placed',
          name: 'award',
          handler: (async (payload: unknown, ctx: never) =>
            void (seen = { payload, ctx })) as never,
        },
      ]),
    ]);
    await bus.publish('order.placed', order, { eventId: 'evt-9' });
    const wire = JSON.parse(JSON.stringify(dispatched[0]?.job));
    await bus.deliver(wire, 2);
    expect(seen?.payload).toEqual(order);
    expect(seen?.ctx).toMatchObject({ eventId: 'evt-9', attempt: 2, extension: 'loyalty' });
  });

  it('rethrows observer failures so the queue retries, logging the extension name', async () => {
    const { bus, dispatched, logs } = setup([
      ext('loyalty', 0, [
        {
          event: 'order.placed',
          name: 'award',
          handler: async () => {
            throw new Error('boom');
          },
        },
      ]),
    ]);
    await bus.publish('order.placed', order);
    await expect(bus.deliver(dispatched[0]!.job, 0)).rejects.toThrow('boom');
    expect(logs.at(-1)).toMatchObject({ extension: 'loyalty', observer: 'award', err: 'boom' });
  });

  it('times out a hung observer', async () => {
    const { bus, dispatched } = setup([
      ext('loyalty', 0, [
        { event: 'order.placed', name: 'award', handler: () => new Promise(() => undefined) },
      ]),
    ]);
    await bus.publish('order.placed', order);
    await expect(bus.deliver(dispatched[0]!.job, 0)).rejects.toThrow(/timed out/);
  });

  it('drops (does not retry) deliveries for observers that no longer exist', async () => {
    const { bus } = setup([]);
    await expect(
      bus.deliver(
        {
          eventId: 'e',
          event: 'order.placed',
          extension: 'gone',
          observer: 'x',
          payload: {},
          occurredAt: '',
        },
        0,
      ),
    ).resolves.toBeUndefined();
  });
});
