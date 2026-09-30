import { defineExtension } from '@sold/extension-sdk';
import { describe, expect, it } from 'vitest';
import { RouteTable } from './route-table';

const handler = async () => new Response('ok');
const manifest = defineExtension({
  name: 'loyalty',
  version: '1.0.0',
  requires: { base: '*' },
  performance: { hotPath: false },
  permissions: [{ key: 'loyalty.points.adjust', description: 'Adjust' }],
  routes: [
    { kind: 'api', method: 'GET', path: '/points/:customerId', public: true, handler },
    {
      kind: 'api',
      method: 'POST',
      path: '/points/:customerId',
      permission: 'loyalty.points.adjust',
      handler,
    },
    { kind: 'webhook', method: 'POST', path: '/hooks/crm', public: true, handler },
    { kind: 'storefront', method: 'GET', path: '/', public: true, handler },
    {
      kind: 'admin',
      method: 'GET',
      path: '/settings',
      permission: 'loyalty.points.adjust',
      handler,
    },
  ],
});
const table = new RouteTable();
table.add(manifest);

describe('RouteTable', () => {
  it('mounts routes under the reserved prefixes', () => {
    expect(table.list().map((r) => r.fullPath)).toEqual([
      '/x/loyalty/points/:customerId',
      '/x/loyalty/points/:customerId',
      '/x/loyalty/hooks/crm',
      '/x/loyalty',
      '/admin/x/loyalty/settings',
    ]);
  });

  it('matches by method and extracts decoded params', () => {
    const get = table.match('GET', '/x/loyalty/points/cust%20one');
    expect(get).toMatchObject({ status: 'found', params: { customerId: 'cust one' } });
    expect(table.match('post', '/x/loyalty/points/c1')).toMatchObject({ status: 'found' });
    expect(table.match('GET', '/x/loyalty')).toMatchObject({ status: 'found' });
    expect(table.match('GET', '/x/loyalty/')).toMatchObject({ status: 'found' });
    expect(table.match('GET', '/admin/x/loyalty/settings')).toMatchObject({ status: 'found' });
  });

  it('distinguishes 405 from 404', () => {
    expect(table.match('DELETE', '/x/loyalty/points/c1')).toEqual({
      status: 'method-not-allowed',
      allowed: ['GET', 'POST'],
    });
    expect(table.match('GET', '/x/loyalty/nothing')).toEqual({ status: 'not-found' });
    expect(table.match('GET', '/x/other/points/c1')).toEqual({ status: 'not-found' });
  });

  it('never lets a path escape its mount or match Base routes', () => {
    for (const p of [
      '/x/loyalty/points/..%2f..%2fadmin',
      '/x/loyalty/../admin',
      '/x/loyalty/points/a%2Fb',
      '/checkout',
      '/admin/settings',
      '/x/loyalty/points/%E0%A4%A',
    ]) {
      expect(table.match('GET', p), p).toEqual({ status: 'not-found' });
    }
  });

  it('admin routes are not reachable under the public prefix and vice versa', () => {
    expect(table.match('GET', '/x/loyalty/settings')).toEqual({ status: 'not-found' });
    expect(table.match('GET', '/admin/x/loyalty/points/c1')).toEqual({ status: 'not-found' });
  });
});
