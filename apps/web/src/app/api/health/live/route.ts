import { route } from '@/server/route';

// Liveness must not depend on any dependency: a database outage must never restart healthy pods.
export const dynamic = 'force-dynamic';

export const GET = route(() =>
  Response.json({ status: 'alive' }, { headers: { 'cache-control': 'no-store' } }),
);
