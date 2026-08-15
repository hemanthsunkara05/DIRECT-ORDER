#!/usr/bin/env node
// docs/11-testing-strategy.md §18.2 names k6 as the documented load-test
// tool, explicitly "staging only." k6 is a standalone Go binary, not an
// npm package, and this sandbox has no way to install standalone binaries
// (same constraint documented in DISASTER_RECOVERY.md for pg_dump/
// pg_restore). autocannon is used instead — a real HTTP load generator,
// installable via pnpm, run here against the real local dev server and
// real local Postgres/Redis (not mocks) — but explicitly LOCAL, not
// staging, and results are reported as such rather than overstating them
// as the docs/11 k6/staging run.
//
// docs/13-implementation-phases.md Phase 19 names "Load testing on
// staging" as in scope; no staging environment exists yet (Phase 20 is
// launch readiness, and no cloud accounts/domains are provisioned — see
// docs/10 §17.8's external-dependency table). This script is the honest
// substitute available today: a real load test against the real local
// stack, not a staging run, and not a synthetic/mocked benchmark.

import autocannon from 'autocannon';

const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? 'http://localhost:4000';
const DURATION_SECONDS = Number(process.env.LOAD_TEST_DURATION ?? 15);
const CONNECTIONS = Number(process.env.LOAD_TEST_CONNECTIONS ?? 20);

// Read-only, unauthenticated, no side effects — safe to hammer without
// polluting order/payment data. Covers the two heaviest real code paths
// on the public browsing journey: restaurant profile and full menu.
const SCENARIOS = [
  { name: 'GET /public/restaurants/:slug', path: '/api/v1/public/restaurants/spice-route' },
  { name: 'GET /public/restaurants/:slug/menu', path: '/api/v1/public/restaurants/spice-route/menu' },
  { name: 'GET /health', path: '/health' },
];

function summarize(result) {
  return {
    requestsPerSecond: result.requests.average,
    latencyMeanMs: result.latency.average,
    latencyP99Ms: result.latency.p99,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    statusCodeStats: result.statusCodeStats,
  };
}

async function runScenario(scenario) {
  console.log(`\n=== ${scenario.name} ===`);
  console.log(`${CONNECTIONS} connections, ${DURATION_SECONDS}s, target ${BASE_URL}${scenario.path}`);
  const result = await autocannon({
    url: `${BASE_URL}${scenario.path}`,
    connections: CONNECTIONS,
    duration: DURATION_SECONDS,
  });
  const summary = summarize(result);
  console.log(`  requests/sec (avg): ${summary.requestsPerSecond}`);
  console.log(`  latency mean: ${summary.latencyMeanMs}ms, p99: ${summary.latencyP99Ms}ms`);
  console.log(`  errors: ${summary.errors}, timeouts: ${summary.timeouts}, non-2xx: ${summary.non2xx}`);
  return { scenario: scenario.name, ...summary };
}

async function main() {
  console.log('=== Phase 19 local load test (autocannon — NOT the docs/11 k6/staging run) ===');
  console.log(`Base URL: ${BASE_URL}`);
  const results = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario));
  }
  console.log('\n=== Summary ===');
  console.table(results.map((r) => ({
    scenario: r.scenario,
    'req/s': r.requestsPerSecond,
    'p99 (ms)': r.latencyP99Ms,
    errors: r.errors,
    timeouts: r.timeouts,
    'non-2xx': r.non2xx,
  })));
  const anyFailures = results.some((r) => r.errors > 0 || r.timeouts > 0 || r.non2xx > 0);
  if (anyFailures) {
    console.log('\nOne or more scenarios had errors/timeouts/non-2xx responses — see above.');
    process.exit(1);
  }
  console.log('\nAll scenarios completed with zero errors, zero timeouts, zero non-2xx responses.');
}

main().catch((error) => {
  console.error('Load test errored:', error);
  process.exit(1);
});
