// Scenario 1 of 8 (Section 8A.9): baseline browse.
// Smoke-level by default so it can run on every PR that touches hot paths; scale up with VUS/DURATION.
//   k6 run -e BASE_URL=http://localhost:3000 baseline-browse.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, tag, targets } from './lib/config.js';

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: __ENV.RAMP || '10s', target: Number(__ENV.VUS || 10) },
        { duration: __ENV.DURATION || '20s', target: Number(__ENV.VUS || 10) },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_failed: [`rate<${targets.maxErrorRate}`],
    'http_req_duration{route:home}': [`p(95)<${targets.browseP95Ms}`],
    'http_req_duration{route:version}': [`p(95)<${targets.browseP95Ms}`],
    'http_req_duration{route:ready}': [`p(95)<${targets.browseP95Ms}`],
    checks: ['rate>0.999'],
  },
};

export default function () {
  const home = http.get(`${BASE_URL}/`, tag('home'));
  check(home, {
    'home 200': (r) => r.status === 200,
    'home has request id': (r) => Boolean(r.headers['X-Request-Id']),
    'home is not personalised (no set-cookie)': (r) => !r.headers['Set-Cookie'],
  });

  const version = http.get(`${BASE_URL}/api/version`, tag('version'));
  check(version, { 'version 200': (r) => r.status === 200 });

  const ready = http.get(`${BASE_URL}/api/health/ready`, tag('ready'));
  check(ready, { 'ready 200': (r) => r.status === 200 });

  sleep(Math.random() * 0.5);
}
