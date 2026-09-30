import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestRedis, type TestRedis } from '@sold/testing';

/**
 * End-to-end proof against REAL Next (not synthetic handler calls): two instances of one build share a Redis
 * through the production cache handler bundle. This is the test that catches contract mismatches such as page
 * tags living in response headers rather than in `ctx.tags`.
 */
const webRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixture = resolve(webRoot, 'test-fixtures/isr-app');
const nextBin = resolve(webRoot, 'node_modules/next/dist/bin/next');

let redis: TestRedis | null;
const children: ChildProcess[] = [];
const buildId = `e2e-${randomBytes(4).toString('hex')}`;
const log: string[] = [];

const port = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });

function run(args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [nextBin, ...args], {
    cwd: fixture,
    env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => log.push(String(d)));
  child.stderr?.on('data', (d) => log.push(String(d)));
  children.push(child);
  return child;
}

async function waitUp(base: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/isr`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start: ${log.join('').slice(-1500)}`);
}

const renderOf = async (base: string) => {
  const res = await fetch(`${base}/isr`);
  const html = await res.text();
  return {
    render: /id="render">([^<]+)</.exec(html)?.[1] ?? '',
    data: /id="data">([^<]+)</.exec(html)?.[1] ?? '',
    cache: res.headers.get('x-nextjs-cache'),
  };
};
const revalidate = (base: string, body: object) =>
  fetch(`${base}/api/revalidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let a = '';
let b = '';

beforeAll(async () => {
  redis = await createTestRedis();
  if (!redis) throw new Error('redis-server not available');
  if (!existsSync(resolve(webRoot, '.generated/cache-handler.cjs')))
    throw new Error('run `node scripts/build.mjs` first');
  const env = {
    REDIS_URL: redis.url,
    SOLD_BUILD_ID: buildId,
    SOLD_ENVIRONMENT: 'local',
    NODE_ENV: 'production',
  };
  const build = run(['build', '--webpack'], env);
  const code = await new Promise<number | null>((r) => build.on('exit', r));
  if (code !== 0) throw new Error(`fixture build failed:\n${log.join('').slice(-3000)}`);
  const [pa, pb] = [await port(), await port()];
  run(['start', '-p', String(pa), '-H', '127.0.0.1'], env);
  run(['start', '-p', String(pb), '-H', '127.0.0.1'], env);
  a = `http://127.0.0.1:${pa}`;
  b = `http://127.0.0.1:${pb}`;
  await Promise.all([waitUp(a), waitUp(b)]);
}, 240_000);

afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  await redis?.stop();
});

describe('ISR through the shared cache handler (real Next, two instances, one Redis)', () => {
  it('both instances serve the same cached render', async () => {
    const first = await renderOf(a);
    const second = await renderOf(b);
    expect(first.render).not.toBe('');
    expect(second.render).toBe(first.render);
  });

  it('revalidatePath on instance A regenerates the page for BOTH instances', async () => {
    const before = await renderOf(b);
    await sleep(20);
    expect((await revalidate(a, { path: '/isr' })).ok).toBe(true);
    const afterB = await renderOf(b);
    expect(afterB.render).not.toBe(before.render);
    const afterA = await renderOf(a);
    expect(afterA.render).toBe(afterB.render); // regenerated once, shared
  });

  it('revalidateTag on instance B invalidates the tagged data AND the page that used it on instance A', async () => {
    const before = await renderOf(a);
    await sleep(20);
    expect((await revalidate(b, { tag: 'ptag' })).ok).toBe(true);
    const after = await renderOf(a);
    expect(after.data).not.toBe(before.data);
    expect(after.render).not.toBe(before.render);
    expect((await renderOf(b)).data).toBe(after.data);
  });

  it('untouched pages stay cached after unrelated revalidations', async () => {
    const before = await renderOf(a);
    await revalidate(a, { path: '/somewhere-else' });
    await sleep(20);
    expect((await renderOf(b)).render).toBe(before.render);
  });

  it('a page is still served (regenerated) when Redis is unreachable', async () => {
    if (process.env.SOLD_TEST_REDIS_URL) return; // cannot kill an external Redis
    await redis?.kill();
    const res = await fetch(`${a}/isr`);
    expect(res.status).toBe(200);
  });
});
