import { randomUUID } from 'node:crypto';
import type { EventMap, EventName, ExtensionContext } from '@sold/extension-sdk';
import { withTimeout } from '../resilience/circuit-breaker';
import { fromJsonSafe, toJsonSafe, type JsonSafe } from '../serialization';
import type { LoadedExtension } from './load-order';

/** What travels through the job queue for one observer of one event. */
export interface ObserverJob {
  eventId: string;
  event: EventName;
  extension: string;
  observer: string;
  payload: JsonSafe;
  occurredAt: string;
}

export interface ObserverDispatcher {
  /** Must be idempotent on `idempotencyKey`. */
  dispatch(job: ObserverJob, idempotencyKey: string): Promise<void>;
}

export interface EventBusOptions {
  extensions: readonly LoadedExtension[];
  dispatcher: ObserverDispatcher;
  /** Builds the I/O-capable context an observer runs in. */
  contextFor(extension: string, signal: AbortSignal): ExtensionContext;
  onLog?(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string): void;
  /** Hard ceiling for one observer run. */
  observerTimeoutMs?: number;
}

export interface PublishResult {
  eventId: string;
  dispatched: number;
  failed: number;
}

/** Queue name carrying an extension's observer deliveries. */
export const observerQueue = (extension: string): string => `ext.${extension}.events`;

/**
 * Observers react to facts: asynchronous, non-blocking, retried by the job queue (Section 4).
 *
 * `publish` only enqueues, so an observer can never slow down or fail the request that raised the event.
 * A dispatch failure is logged and counted, never thrown. Events that must not be lost (order placed,
 * payment captured) go through the transactional outbox first; the relay calls `publish`, and the
 * per-observer idempotency key makes redelivery harmless.
 */
export class EventBus {
  private readonly subscribers = new Map<EventName, { extension: string; observer: string }[]>();
  private readonly handlers = new Map<string, LoadedExtension['manifest']['observers'][number]>();
  private readonly timeoutMs: number;

  constructor(private readonly opts: EventBusOptions) {
    this.timeoutMs = opts.observerTimeoutMs ?? 30_000;
    for (const { manifest } of opts.extensions) {
      for (const o of manifest.observers) {
        const list = this.subscribers.get(o.event) ?? [];
        list.push({ extension: manifest.name, observer: o.name });
        this.subscribers.set(o.event, list);
        this.handlers.set(`${manifest.name}/${o.name}`, o);
      }
    }
  }

  subscriberCount(event: EventName): number {
    return this.subscribers.get(event)?.length ?? 0;
  }

  async publish<E extends EventName>(
    event: E,
    payload: EventMap[E],
    opts: { eventId?: string } = {},
  ): Promise<PublishResult> {
    const eventId = opts.eventId ?? randomUUID();
    const subs = this.subscribers.get(event) ?? [];
    if (subs.length === 0) return { eventId, dispatched: 0, failed: 0 };
    const encoded = toJsonSafe(payload);
    const occurredAt = new Date().toISOString();
    const results = await Promise.allSettled(
      subs.map((s) =>
        this.opts.dispatcher.dispatch(
          {
            eventId,
            event,
            extension: s.extension,
            observer: s.observer,
            payload: encoded,
            occurredAt,
          },
          `${eventId}:${s.extension}:${s.observer}`,
        ),
      ),
    );
    let failed = 0;
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed++;
        this.opts.onLog?.(
          'error',
          {
            event,
            eventId,
            extension: subs[i]?.extension,
            observer: subs[i]?.observer,
            err: String(r.reason),
          },
          'observer dispatch failed',
        );
      }
    });
    return { eventId, dispatched: subs.length - failed, failed };
  }

  /**
   * Run one delivery (called by the queue worker). Throws on failure so the queue retries with backoff and
   * finally dead-letters; the error is logged with the extension name first.
   */
  async deliver(job: ObserverJob, attempt: number): Promise<void> {
    const handler = this.handlers.get(`${job.extension}/${job.observer}`);
    if (!handler) {
      // The extension was disabled or the observer removed after the job was queued. Not retryable.
      this.opts.onLog?.(
        'warn',
        { extension: job.extension, observer: job.observer, event: job.event },
        'observer no longer registered; dropping delivery',
      );
      return;
    }
    const controller = new AbortController();
    try {
      const ctx = {
        ...this.opts.contextFor(job.extension, controller.signal),
        eventId: job.eventId,
        attempt,
      };
      await withTimeout(
        Promise.resolve(
          (handler.handler as (p: unknown, c: unknown) => Promise<void>)(
            fromJsonSafe(job.payload),
            ctx,
          ),
        ),
        this.timeoutMs,
        `${job.extension}/${job.observer}`,
      );
    } catch (error) {
      controller.abort();
      this.opts.onLog?.(
        'error',
        {
          extension: job.extension,
          observer: job.observer,
          event: job.event,
          eventId: job.eventId,
          attempt,
          err: error instanceof Error ? error.message : String(error),
        },
        'observer failed',
      );
      throw error;
    }
  }
}
