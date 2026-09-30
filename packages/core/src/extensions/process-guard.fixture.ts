/**
 * Child process used by process-guard.test.ts: raises REAL unhandled rejections and uncaught exceptions and prints
 * what the guard did. Not a test itself.
 */
import { EventBus } from './event-bus';
import { installHotPathGuard } from './hot-path-guard';
import { InterceptorRunner } from './interceptor-runner';
import { installProcessGuard, runAsExtension } from './process-guard';
import { Semaphore } from '../resilience/semaphore';
import { defineExtension } from '@sold/extension-sdk';

const mode = process.argv[2] ?? '';
const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

installProcessGuard({
  log: (_level, fields) =>
    say({ log: { kind: fields.kind, extension: fields.extension, fatal: fields.fatal } }),
  onFailure: (f) => say({ failure: { kind: f.kind, extension: f.extension, fatal: f.fatal } }),
});

function extension(name: string, handler: () => unknown, kind: 'observer' | 'interceptor') {
  return defineExtension({
    name,
    version: '1.0.0',
    requires: { base: '*' },
    performance: { hotPath: kind === 'interceptor', budgetMs: 30 },
    ...(kind === 'observer'
      ? { observers: [{ event: 'order.placed' as const, name: 'o', handler: handler as never }] }
      : {
          interceptors: [
            {
              hook: 'cart.item.adding' as const,
              name: 'i',
              failPolicy: 'open' as const,
              handler: handler as never,
            },
          ],
        }),
  });
}

async function main(): Promise<void> {
  if (mode === 'observer-floating-rejection' || mode === 'observer-timer-throw') {
    const ext = extension(
      'careless',
      async () => {
        if (mode === 'observer-floating-rejection') void Promise.reject(new Error('floating'));
        else setTimeout(() => void (undefined as unknown as () => void)(), 5); // TypeError from a timer
      },
      'observer',
    );
    const bus = new EventBus({
      extensions: [{ manifest: ext, origin: 'instance', index: 0 }],
      dispatcher: { dispatch: async () => undefined },
      contextFor: () => ({}) as never,
    });
    await bus.deliver(
      {
        eventId: 'e',
        event: 'order.placed',
        extension: 'careless',
        observer: 'o',
        payload: {},
        occurredAt: '',
      } as never,
      0,
    );
    say({ delivered: true });
  } else if (mode === 'interceptor-floating-fetch') {
    installHotPathGuard({ monitor: false });
    const ext = extension(
      'floaty',
      async () => {
        void fetch('http://127.0.0.1:9/'); // un-awaited: the guard's rejection has nobody to handle it
      },
      'interceptor',
    );
    const runner = new InterceptorRunner({
      extensions: [{ manifest: ext, origin: 'instance', index: 0 }],
      contextFor: () => ({}) as never,
      pool: new Semaphore('p', 4, 4),
      onLog: () => undefined,
    });
    say({
      ran: (await runner.run('cart.item.adding', { cartId: 'c', variantId: 'v', quantity: 1 }))
        .veto,
    });
  } else if (mode === 'unattributed-rejection') {
    void Promise.reject(new Error('base bug'));
  } else if (mode === 'unattributed-throw') {
    setTimeout(() => {
      throw new Error('base bug');
    }, 1);
  } else if (mode === 'scoped-throw') {
    runAsExtension({ extension: 'scoped', kind: 'job' }, () =>
      setTimeout(() => {
        throw new Error('job bug');
      }, 1),
    );
  }
  await new Promise((r) => setTimeout(r, 100));
  say({ alive: true });
}

void main();
