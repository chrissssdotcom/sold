import { defineExtension } from '@sold/extension-sdk';
import { hello } from './hello.route';
import { recordOrder } from './record-order.observer';
import { settings } from './settings';

/**
 * File-name convention (the lint keys off it, see docs/extending.md): `*.interceptor.ts` for cart/checkout
 * interceptors (pure: no I/O), `*.observer.ts`, `*.job.ts` and `*.route.ts` for code that may use I/O. Every
 * other file, like this one, is strict: no network, filesystem or process access.
 */
export default defineExtension({
  name: '__NAME__',
  version: '0.1.0',
  description: '__TITLE__',
  requires: { base: '__BASE_RANGE__' },
  // No interceptors on cart or checkout, so this is not a hot-path extension.
  performance: { hotPath: false },
  migrations: { dir: 'migrations' },
  settings: { schema: settings },
  permissions: [{ key: '__NAME__.events.read', description: 'View __NAME__ events' }],
  observers: [recordOrder],
  routes: [hello],
});
