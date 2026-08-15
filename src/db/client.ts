import pg from "pg";

const { Pool, types } = pg;

// By default node-postgres parses `timestamptz` into a JS Date, which
// gets re-serialized through several layers of our code (query results,
// cursor encoding). Forcing it to stay a raw string (Postgres already
// returns it in a Date.parse()-compatible format) avoids any ambiguity
// about which layer is responsible for ISO formatting — every consumer
// just calls `new Date(value).toISOString()` once, at the response edge.
types.setTypeParser(1184 /* timestamptz */, (value) => value);

// Pool sizing rationale:
// Postgres is capped at 1 CPU / 1GB RAM. Each Postgres backend connection
// costs real memory and, with only one CPU, more than a handful of
// concurrent connections just means more context-switching, not more
// throughput. A small pool (8) plus batched multi-row inserts gives far
// better throughput here than a large pool of connections fighting over
// one core. Tune via PG_POOL_MAX if the load test says otherwise.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // statement_timeout guards against a single slow ad-hoc query (e.g. a
  // pathological attribute filter) starving the pool for everyone else.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000),
});

pool.on("error", (err) => {
  // Errors on idle clients (e.g. connection dropped by the server) must
  // not crash the process — just log and let the pool recycle it.
  // eslint-disable-next-line no-console
  console.error("Unexpected error on idle Postgres client", err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

export async function withClient<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function checkConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function shutdownPool(): Promise<void> {
  await pool.end();
}

export default pool;
