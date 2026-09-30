import { schema } from '@sold/db';
import { toJsonSafe } from '@sold/core';
import type { Tx } from './types';

export interface OutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

/**
 * Write an event to the transactional outbox. MUST be called inside the same transaction as the state
 * change it describes: the event exists if and only if the change committed. The relay (worker)
 * publishes it afterwards, at least once.
 */
export async function writeOutbox(tx: Tx, event: OutboxEvent): Promise<void> {
  await tx.insert(schema.outboxEvents).values({
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: toJsonSafe(event.payload),
  });
}
