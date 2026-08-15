// Minimal, dependency-free contract smoke test used by CI.
// Run against a live service: BASE_URL=http://localhost:8080 npm run test:smoke
// If AUTH_TOKEN is set, also verifies the authenticated configuration.

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const AUTH_TOKEN = process.env.AUTH_TOKEN;

let failures = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  - ${name}`);
  } else {
    console.error(`FAIL - ${name}`);
    failures++;
  }
}

async function main(): Promise<void> {
  console.log(`smoke test against ${BASE_URL} (auth token set: ${Boolean(AUTH_TOKEN)})`);

  // 1. /health must be reachable with no credentials.
  const health = await fetch(`${BASE_URL}/health`);
  check("GET /health returns 200", health.status === 200);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const authedHeaders = AUTH_TOKEN
    ? { ...headers, Authorization: `Bearer ${AUTH_TOKEN}` }
    : headers;

  // 2. POST /api/v1/logs — a mixed valid/invalid batch.
  const ingestRes = await fetch(`${BASE_URL}/api/v1/logs`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({
      logs: [
        {
          timestamp: new Date().toISOString(),
          level: "info",
          service: "smoke-test",
          message: "hello from CI",
          attributes: { run: "ci" },
        },
        { level: "not-a-real-level", service: "x", message: "bad entry" },
      ],
    }),
  });
  const ingestBody = await ingestRes.json();
  check("POST /api/v1/logs returns 202", ingestRes.status === 202);
  check("POST /api/v1/logs accepted >= 1", (ingestBody.accepted ?? 0) >= 1);
  check("POST /api/v1/logs rejected has 1 entry", (ingestBody.rejected ?? []).length === 1);

  // Newly ingested data must become queryable within 20s per the spec;
  // for a CI smoke test we just give it a short, generous grace period.
  await new Promise((r) => setTimeout(r, 1000));

  // 3. GET /api/v1/logs/query
  const queryRes = await fetch(
    `${BASE_URL}/api/v1/logs/query?service=smoke-test&limit=5`,
    { headers: authedHeaders }
  );
  const queryBody = await queryRes.json();
  check("GET /api/v1/logs/query returns 200", queryRes.status === 200);
  check("GET /api/v1/logs/query returns logs array", Array.isArray(queryBody.logs));

  // 4. GET /api/v1/logs/aggregate
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const aggRes = await fetch(
    `${BASE_URL}/api/v1/logs/aggregate?start=${start}&end=${end}&bucket=1h`,
    { headers: authedHeaders }
  );
  const aggBody = await aggRes.json();
  check("GET /api/v1/logs/aggregate returns 200", aggRes.status === 200);
  check("GET /api/v1/logs/aggregate returns buckets array", Array.isArray(aggBody.buckets));

  // 5. If auth is enabled, an unauthenticated request to a data endpoint
  // must be rejected with 401.
  if (AUTH_TOKEN) {
    const unauthedRes = await fetch(`${BASE_URL}/api/v1/logs/query`);
    check("unauthenticated request rejected with 401 when auth enabled", unauthedRes.status === 401);
  }

  if (failures > 0) {
    console.error(`\n${failures} smoke test check(s) failed`);
    process.exit(1);
  }
  console.log("\nall smoke test checks passed");
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
