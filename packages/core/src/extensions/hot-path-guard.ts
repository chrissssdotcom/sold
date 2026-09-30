import { AsyncLocalStorage } from 'node:async_hooks';
import net from 'node:net';

/**
 * Runtime guard for the extension performance contract (Section 8A.8): interceptors on cart and checkout
 * are forbidden from making synchronous external calls. While an interceptor runs, opening a new network
 * connection or calling `fetch` throws `HotPathViolation`.
 *
 * Defence in depth, not a sandbox: the interceptor context has no I/O clients, the lint bans network
 * imports in extension code, and this catches what slips through. It cannot stop a pooled keep-alive
 * connection being reused or a synchronous CPU loop; true isolation would need worker threads.
 */
export class HotPathViolation extends Error {
  constructor(
    public readonly extension: string,
    public readonly interceptor: string,
    public readonly operation: string,
  ) {
    super(
      `Extension "${extension}" interceptor "${interceptor}" attempted ${operation} on the cart/checkout hot path`,
    );
    this.name = 'HotPathViolation';
  }
}

interface Scope {
  extension: string;
  interceptor: string;
}

const storage = new AsyncLocalStorage<Scope>();

export function runInHotPath<T>(scope: Scope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentHotPathScope(): Scope | undefined {
  return storage.getStore();
}

interface Restore {
  connect: typeof net.Socket.prototype.connect;
  fetch: typeof globalThis.fetch | undefined;
}
let installed: Restore | null = null;

/** Idempotent. Call once at boot in any process that runs interceptors. */
export function installHotPathGuard(): void {
  if (installed) return;
  const originalConnect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  installed = { connect: originalConnect, fetch: originalFetch };

  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const scope = storage.getStore();
    if (scope)
      throw new HotPathViolation(scope.extension, scope.interceptor, 'a network connection');
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  if (originalFetch) {
    globalThis.fetch = function guardedFetch(...args: Parameters<typeof fetch>) {
      const scope = storage.getStore();
      if (scope)
        return Promise.reject(new HotPathViolation(scope.extension, scope.interceptor, 'fetch()'));
      return originalFetch(...args);
    } as typeof fetch;
  }
}

/** For tests. */
export function uninstallHotPathGuard(): void {
  if (!installed) return;
  net.Socket.prototype.connect = installed.connect;
  if (installed.fetch) globalThis.fetch = installed.fetch;
  installed = null;
}
