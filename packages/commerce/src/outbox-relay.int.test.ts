import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeOutbox } from './outbox';
import { drainOutbox, relayBackoffSeconds, relayOutbox, type RelayEvent } from './outbox-relay';
import { openMigrated } from './test-support';

let testDb: TestDatabase;
let db: Db;
beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 20);
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

async function emit(n: number, type = 't.event') {
  await db.primary.transaction(async (tx) => {
    for (let i = 0; i < n; i++)
      await writeOutbox(tx, {
        aggregateType: 'thing',
        aggregateId: String(i),
        eventType: type,
        payload: { i, big: 2n ** 70n, at: new Date('2026-05-01T00:00:00Z') },
      });
  });
}
const reset = () => db.primary.execute(sql`DELETE FROM outbox_events`);

describe('outbox', () => {
  it('an event exists iff its transaction committed', async () => {
    await reset();
    await expect(
      db.primary.transaction(async (tx) => {
        await writeOutbox(tx, {
          aggregateType: 'a',
          aggregateId: '1',
          eventType: 'x',
          payload: {},
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const n = (
      await db.primary.execute<{ c: string }>(sql`SELECT count(*) AS c FROM outbox_events`)
    ).rows[0]!;
    expect(Number(n.c)).toBe(0);
  });

  it('publishes each row, decoding bigint/Date, and marks it published', async () => {
    await reset();
    await emit(3);
    const seen: RelayEvent[] = [];
    const r = await relayOutbox(db.primary, async (e) => void seen.push(e));
    expect(r).toEqual({ published: 3, failed: 0 });
    expect(seen[0]!.payload).toMatchObject({
      big: 2n ** 70n,
      at: new Date('2026-05-01T00:00:00Z'),
    });
    expect(await relayOutbox(db.primary, async () => undefined)).toEqual({
      published: 0,
      failed: 0,
    });
  });

  it('a failing publish is retried later with backoff, never lost, never blocks the others', async () => {
    await reset();
    await emit(4);
    let calls = 0;
    const r = await relayOutbox(db.primary, async (e) => {
      calls++;
      if ((e.payload as { i: number }).i === 2) throw new Error('bus down');
    });
    expect(r).toEqual({ published: 3, failed: 1 });
    expect(calls).toBe(4);
    const row = (
      await db.primary.execute<{ attempts: number; delayed: boolean }>(
        sql`SELECT attempts, available_at > now() AS delayed FROM outbox_events WHERE published_at IS NULL`,
      )
    ).rows;
    expect(row).toEqual([{ attempts: 1, delayed: true }]);
    // Once the delay passes it is delivered.
    await db.primary.execute(
      sql`UPDATE outbox_events SET available_at = now() WHERE published_at IS NULL`,
    );
    expect(await relayOutbox(db.primary, async () => undefined)).toEqual({
      published: 1,
      failed: 0,
    });
  });

  it('concurrent relays publish every event exactly once (SKIP LOCKED)', async () => {
    await reset();
    await emit(500);
    const ids = new Map<string, number>();
    const publish = async (e: RelayEvent) => {
      await new Promise((r) => setTimeout(r, 1));
      ids.set(e.eventId, (ids.get(e.eventId) ?? 0) + 1);
    };
    await Promise.all(
      Array.from({ length: 6 }, () => drainOutbox(db.primary, publish, { batch: 25 })),
    );
    expect(ids.size).toBe(500);
    expect([...ids.values()].every((n) => n === 1)).toBe(true);
    const left = (
      await db.primary.execute<{ c: string }>(
        sql`SELECT count(*) AS c FROM outbox_events WHERE published_at IS NULL`,
      )
    ).rows[0]!;
    expect(Number(left.c)).toBe(0);
  });

  it('a crash after publish but before commit republishes (at-least-once): eventId is stable', async () => {
    await reset();
    await emit(1);
    const ids: string[] = [];
    await expect(
      db.primary.transaction(async (tx) => {
        await relayOutbox(tx, async (e) => void ids.push(e.eventId));
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash');
    await relayOutbox(db.primary, async (e) => void ids.push(e.eventId));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('backoff grows and is capped', () => {
    expect([1, 2, 3, 4].map((n) => relayBackoffSeconds(n))).toEqual([2, 4, 8, 16]);
    expect(relayBackoffSeconds(50)).toBe(300);
  });
});
