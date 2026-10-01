import { FeatureFlags } from '@sold/db';
import {
  sheddableClasses,
  shedBelowFrom,
  shedBelowFromEnv,
  shedFlagKey,
  strictestShed,
  type RouteClass,
} from '@sold/core/traffic';
import { getRuntime } from './runtime';

/** Paths that must stay reachable while shedding, or an operator could not turn shedding off. */
const EXEMPT = [/^\/api\/admin\/flags(?:\/|$)/, /^\/api\/admin\/auth(?:\/|$)/];
export const isShedExempt = (pathname: string): boolean => EXEMPT.some((re) => re.test(pathname));

const slot = globalThis as unknown as { __soldShedFlags?: FeatureFlags };

/**
 * Which class (and everything below it) is currently being shed, or null. Flags are cached ~5 s per instance and fail
 * static if the database is unreachable, so a database outage neither starts nor stops shedding by accident. The
 * `SOLD_SHED_BELOW` environment variable is a hard floor that needs no database at all.
 */
export async function currentShedBelow(): Promise<RouteClass | null> {
  const rt = getRuntime();
  const fromEnv = shedBelowFromEnv(process.env['SOLD_SHED_BELOW']);
  const flags = (slot.__soldShedFlags ??= new FeatureFlags(rt.db.replica));
  const on = new Set<string>();
  await Promise.all(
    sheddableClasses.map(async (cls) => {
      if (await flags.isEnabled(shedFlagKey(cls))) on.add(shedFlagKey(cls));
    }),
  );
  return strictestShed(fromEnv, shedBelowFrom(on));
}
