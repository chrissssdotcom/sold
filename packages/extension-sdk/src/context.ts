import type { ExtensionDb } from './db';

/** Structured logger handed to extensions. Every line is tagged with the extension name by Base. */
export interface ExtensionLogger {
  debug(fields: Record<string, unknown> | string, message?: string): void;
  info(fields: Record<string, unknown> | string, message?: string): void;
  warn(fields: Record<string, unknown> | string, message?: string): void;
  error(fields: Record<string, unknown> | string, message?: string): void;
}

/** Read-only view of the extension's own settings (secrets already decrypted). */
export interface SettingsView<S = Record<string, unknown>> {
  get(): Promise<S>;
}

export interface QueueClient {
  /** Enqueue onto one of this extension's own queues (declared under `jobs`). */
  enqueue(
    queue: string,
    data: object,
    options?: { idempotencyKey?: string; startAfterSeconds?: number },
  ): Promise<string | null>;
}

export interface Actor {
  id: string;
  kind: 'admin' | 'customer' | 'api-key' | 'system';
  /** Permissions held right now (resolved by Base from the live session on this request). Set by Base only. */
  permissions?: readonly string[];
}

interface Common<S> {
  /** Name of the extension this code belongs to. */
  extension: string;
  log: ExtensionLogger;
  settings: SettingsView<S>;
  /** Aborted when the work should stop (timeout, shutdown). */
  signal: AbortSignal;
}

/** Context for observers, jobs, lifecycle hooks and admin/API routes: may do I/O. */
export interface ExtensionContext<S = Record<string, unknown>> extends Common<S> {
  db: ExtensionDb;
  queue: QueueClient;
  requestId?: string;
}

export interface RouteContext<S = Record<string, unknown>> extends ExtensionContext<S> {
  actor: Actor | null;
  requestId: string;
}

/**
 * Context for interceptors. Deliberately has **no I/O**: no database, no queue, no network.
 * Hot-path interceptors run synchronously inside cart and checkout, so they must be pure computation over
 * the payload and a cached settings snapshot (Section 8A.8). Base enforces this at runtime too.
 */
export interface InterceptorContext<S = Record<string, unknown>> extends Common<S> {
  /** Remaining time budget in ms for this interceptor. */
  budgetMs: number;
}
