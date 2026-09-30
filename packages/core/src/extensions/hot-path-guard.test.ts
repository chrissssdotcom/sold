import { afterEach, describe, expect, it } from 'vitest';
import {
  beginHotPathCall,
  onHotPathBlocked,
  startEventLoopMonitor,
  type HotPathBlockedEvent,
} from './hot-path-guard';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

describe('event-loop monitor', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((f) => f()));

  function watch() {
    const events: HotPathBlockedEvent[] = [];
    cleanup.push(onHotPathBlocked((e) => events.push(e)));
    cleanup.push(startEventLoopMonitor({ intervalMs: 5, minStallMs: 10 }));
    return events;
  }

  it('attributes a stall to the only interceptor in flight (as a suspicion: source event-loop-lag)', async () => {
    const events = watch();
    await sleep(15);
    const call = beginHotPathCall({ extension: 'stally', interceptor: 'slow', budgetMs: 5 });
    setTimeout(() => busy(60), 0);
    await sleep(120);
    call.end();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      extension: 'stally',
      interceptor: 'slow',
      source: 'event-loop-lag',
      budgetMs: 5,
    });
    expect(events[0]?.blockedMs).toBeGreaterThan(40);
  });

  it('does not blame anyone when several interceptors were in flight, or none', async () => {
    const events = watch();
    await sleep(15);
    const a = beginHotPathCall({ extension: 'a', interceptor: 'i', budgetMs: 5 });
    const b = beginHotPathCall({ extension: 'b', interceptor: 'i', budgetMs: 5 });
    setTimeout(() => busy(50), 0);
    await sleep(100);
    a.end();
    b.end();
    setTimeout(() => busy(50), 0); // nothing in flight
    await sleep(100);
    expect(events).toEqual([]);
  });

  it('does not report a stall that is within the interceptor budget', async () => {
    const events = watch();
    await sleep(15);
    const call = beginHotPathCall({ extension: 'a', interceptor: 'i', budgetMs: 500 });
    setTimeout(() => busy(30), 0);
    await sleep(80);
    call.end();
    expect(events).toEqual([]);
  });

  it('does not repeat a stall the runner already reported exactly', async () => {
    const events = watch();
    await sleep(15);
    const call = beginHotPathCall({ extension: 'a', interceptor: 'i', budgetMs: 5 });
    setTimeout(() => {
      call.markReported();
      busy(50);
    }, 0);
    await sleep(100);
    call.end();
    expect(events).toEqual([]);
  });

  it('a throwing listener never affects anyone', async () => {
    cleanup.push(
      onHotPathBlocked(() => {
        throw new Error('listener bug');
      }),
    );
    const events = watch();
    await sleep(15);
    const call = beginHotPathCall({ extension: 'a', interceptor: 'i', budgetMs: 5 });
    setTimeout(() => busy(50), 0);
    await sleep(100);
    call.end();
    expect(events).toHaveLength(1);
  });
});
