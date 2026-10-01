#!/usr/bin/env node
// Dependency-free load generator for environments without k6 (and for the CI-less sandbox this was built in).
// Same scenario shapes as the k6 files in ../, but closed-loop (a worker issues its next request when the last one returns),
// so it UNDER-reports tail latency during stalls (coordinated omission). Treat its numbers as relative, and label them.
//
//   node load.mjs browse --base http://localhost:3000 --workers 20 --seconds 30
//   node load.mjs spike --base ... --from 2 --to 100 --ramp 30 --hold 30 --recover 20
//   node load.mjs checkout-storm --base ... --buyers 300 --stock 50 --owner-email ... --owner-password ...
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';

const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    workers: { type: 'string', default: '20' },
    seconds: { type: 'string', default: '30' },
    from: { type: 'string', default: '2' },
    to: { type: 'string', default: '100' },
    ramp: { type: 'string', default: '30' },
    hold: { type: 'string', default: '30' },
    recover: { type: 'string', default: '20' },
    buyers: { type: 'string', default: '300' },
    stock: { type: 'string', default: '50' },
    'owner-email': { type: 'string', default: process.env.SOLD_E2E_OWNER_EMAIL },
    'owner-password': { type: 'string', default: process.env.SOLD_E2E_OWNER_PASSWORD },
    out: { type: 'string' },
    label: { type: 'string', default: 'unlabelled' },
  },
});
const scenario = positionals[0] ?? 'browse';
const base = a.base;
const num = (k) => Number(a[k]);

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
function summarize(samples, seconds) {
  const lat = samples.map((s) => s.ms).sort((x, y) => x - y);
  const by = {};
  for (const s of samples) by[s.status] = (by[s.status] ?? 0) + 1;
  const bad = samples.filter((s) => s.status === 0 || s.status >= 500).length;
  return {
    requests: samples.length,
    rps: +(samples.length / Math.max(seconds, 0.001)).toFixed(1),
    errorRate: +(bad / Math.max(samples.length, 1)).toFixed(4),
    p50: +pct(lat, 50).toFixed(1),
    p95: +pct(lat, 95).toFixed(1),
    p99: +pct(lat, 99).toFixed(1),
    max: +(lat.at(-1) ?? 0).toFixed(1),
    statuses: by,
  };
}

async function timed(url, init) {
  const t = performance.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    await r.arrayBuffer();
    return { ms: performance.now() - t, status: r.status, res: r };
  } catch {
    return { ms: performance.now() - t, status: 0, res: null };
  }
}

async function catalog() {
  const list = await (await fetch(`${base}/api/catalog/products?limit=20`)).json();
  const handles = list.items.map((p) => p.handle);
  if (!handles.length) throw new Error('no products: seed the catalog first');
  return handles;
}

/** One browsing "page view": pages are cacheable and shared; the API calls are the dynamic path. */
function browser(handles) {
  const pick = () => handles[Math.floor(Math.random() * handles.length)];
  const steps = [
    () => `/en-au`,
    () => `/en-au/products/${pick()}`,
    () => `/api/catalog/products?limit=20`,
    () => `/api/catalog/products/${pick()}`,
  ];
  let i = Math.floor(Math.random() * steps.length);
  return () => steps[i++ % steps.length]();
}

async function worker(handles, until, sink, stopped = () => false) {
  const next = browser(handles);
  while (performance.now() < until && !stopped()) {
    const { ms, status } = await timed(base + next());
    sink.push({ ms, status, at: performance.now() });
  }
}

async function runBrowse() {
  const handles = await catalog();
  const sink = [];
  const t0 = performance.now();
  const until = t0 + num('seconds') * 1000;
  await Promise.all(Array.from({ length: num('workers') }, () => worker(handles, until, sink)));
  return { ...summarize(sink, (performance.now() - t0) / 1000), workers: num('workers') };
}

async function runSpike() {
  const handles = await catalog();
  const sink = [];
  const t0 = performance.now();
  const total = num('ramp') + num('hold') + num('recover');
  const target = (sec) =>
    sec < num('ramp')
      ? Math.round(num('from') + ((num('to') - num('from')) * sec) / num('ramp'))
      : sec < num('ramp') + num('hold')
        ? num('to')
        : num('from');
  const live = new Set();
  let spawned = 0;
  const all = [];
  const until = t0 + total * 1000;
  while (performance.now() < until) {
    const sec = (performance.now() - t0) / 1000;
    const want = target(sec);
    while (live.size < want) {
      const id = spawned++;
      live.add(id);
      all.push(worker(handles, until, sink, () => !live.has(id)));
    }
    while (live.size > want) live.delete([...live].pop());
    await new Promise((r) => setTimeout(r, 250));
  }
  live.clear();
  await Promise.all(all);
  const phase = (from, to) =>
    summarize(
      sink.filter((s) => (s.at - t0) / 1000 >= from && (s.at - t0) / 1000 < to),
      to - from,
    );
  return {
    baseline: phase(0, Math.min(5, num('ramp'))),
    ramp: phase(0, num('ramp')),
    hold: phase(num('ramp'), num('ramp') + num('hold')),
    recovery: phase(num('ramp') + num('hold'), total),
    peakWorkers: num('to'),
  };
}

class Jar {
  jar = new Map();
  async call(method, path, body, headers = {}) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const t = performance.now();
    let res;
    try {
      res = await fetch(base + path, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(method === 'GET' ? {} : { origin: base }),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return { status: 0, body: {}, ms: performance.now() - t };
    }
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {}; // non-JSON body (e.g. an HTML error page): the status code still counts
    }
    return { status: res.status, body: parsed, ms: performance.now() - t };
  }
}

const address = {
  name: 'Load Buyer',
  line1: '1 Test St',
  city: 'Sydney',
  region: 'NSW',
  postalCode: '2000',
  country: 'AU',
};

/** N buyers race for S units of one hot SKU. Invariants: orders placed <= S (never oversell); the rest are refused cleanly, not 5xx. */
async function runCheckoutStorm() {
  const owner = new Jar();
  const login = await owner.call('POST', '/api/admin/auth/login', {
    email: a['owner-email'],
    password: a['owner-password'],
  });
  if (login.status !== 200) throw new Error(`owner login failed: ${login.status}`);
  const list = await (await fetch(`${base}/api/catalog/products?limit=1`)).json();
  const detail = await (await fetch(`${base}/api/catalog/products/${list.items[0].handle}`)).json();
  const variantId = detail.variants[0].id;
  const stock = num('stock');
  const set = await owner.call('PUT', `/api/admin/variants/${variantId}/stock`, { onHand: stock });
  if (set.status !== 200) throw new Error(`could not set stock: ${set.status}`);

  const outcomes = { placed: 0, soldOut: 0, other4xx: 0, serverError: 0, networkError: 0 };
  const lat = [];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: num('buyers') }, async () => {
      const b = new Jar();
      await b.call('POST', '/api/cart', { currency: 'AUD' });
      const add = await b.call('POST', '/api/cart/items', { variantId, quantity: 1 });
      const classify = (r) => {
        if (r.status === 0) outcomes.networkError++;
        else if (r.status >= 500) outcomes.serverError++;
        else if (r.status === 409 || r.status === 422) outcomes.soldOut++;
        else outcomes.other4xx++;
      };
      if (add.status !== 200) return classify(add);
      const quote = await b.call('POST', '/api/checkout/quote', { shippingAddress: address });
      if (quote.status !== 200) return classify(quote);
      const placed = await b.call(
        'POST',
        '/api/checkout',
        {
          email: `storm-${crypto.randomUUID().slice(0, 8)}@example.test`,
          shippingAddress: address,
          shippingMethodId: quote.body.shippingOptions[0].methodId,
        },
        { 'idempotency-key': crypto.randomUUID() },
      );
      lat.push(placed.ms);
      if (placed.status === 201) outcomes.placed++;
      else classify(placed);
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  lat.sort((x, y) => x - y);
  const verdict = {
    oversold: Math.max(0, outcomes.placed - stock),
    ok: outcomes.placed <= stock && outcomes.serverError === 0 && outcomes.networkError === 0,
  };
  return {
    buyers: num('buyers'),
    stock,
    seconds: +seconds.toFixed(1),
    outcomes,
    checkoutP50: +pct(lat, 50).toFixed(1),
    checkoutP95: +pct(lat, 95).toFixed(1),
    verdict,
  };
}

const runners = { browse: runBrowse, spike: runSpike, 'checkout-storm': runCheckoutStorm };
if (!runners[scenario]) {
  console.error(`unknown scenario ${scenario}; one of ${Object.keys(runners).join(', ')}`);
  process.exit(2);
}
const result = await runners[scenario]();
const report = {
  scenario,
  label: a.label,
  base,
  when: new Date().toISOString(),
  node: process.version,
  cpus: (await import('node:os')).cpus().length,
  closedLoop: true,
  result,
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (a.out) writeFileSync(a.out, JSON.stringify(report, null, 2) + '\n');
if (result.verdict && !result.verdict.ok) process.exit(1);
