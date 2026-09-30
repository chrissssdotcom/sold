// Shared by every scenario. Thresholds are the pass/fail contract: a regression fails the build (Section 8A.9).
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

/** Design targets from docs/scaling.md (initial assumptions until validated by the capacity report). */
export const targets = {
  // Cache-hit pages: origin p95 on a miss.
  browseP95Ms: 400,
  // Cart and checkout APIs at peak.
  cartP95Ms: 500,
  cartP99Ms: 1500,
  // No errors on cached routes.
  maxErrorRate: 0.001,
};

/** @param {string} name */
export function tag(name) {
  return { tags: { route: name } };
}
