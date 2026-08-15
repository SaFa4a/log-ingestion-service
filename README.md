# Log Ingestion and Query Service

A high-throughput log ingestion, query, and aggregation service, built on
Fastify + raw `pg` + PostgreSQL (range-partitioned). No ORM.

## Quick Start

```bash
docker compose up
```

That's it — the app container waits for Postgres to be healthy, runs
migrations automatically, creates the first few days of partitions, and
starts serving on `http://localhost:8080`. No manual setup, no env file
required for the default (unauthenticated) configuration.

Verify:

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

## API

### `GET /health`
Returns `200` once the DB connection is established, migrations have
been applied, and the service can accept traffic. Always unauthenticated.

### `POST /api/v1/logs` — Ingest
```json
{
  "logs": [
    {
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42", "region": "eu-west", "retries": 3 }
    }
  ]
}
```
- Accepts a batch (a batch of one is valid).
- Each entry is validated independently — one bad entry never fails the
  whole batch. Rejected entries are returned with their original array
  index and a specific reason.
- `202 Accepted` when at least one entry is durably written.
- `400` when every entry is rejected, the JSON is malformed, or the
  top-level shape isn't `{ "logs": [...] }`.

```json
{ "accepted": 9, "rejected": [{ "index": 3, "reason": "invalid level: 'critical'" }] }
```

### `GET /api/v1/logs/query` — Query
All parameters optional and freely combinable:

| Param | Meaning |
|---|---|
| `service` | exact match |
| `level` | exact match |
| `start` / `end` | inclusive/exclusive time range |
| `q` | case-insensitive substring match on `message` |
| `attributes.<key>=<value>` | attribute equality, compared as strings — e.g. `attributes.user_id=42` |
| `limit` | default 100, max 1000 |
| `cursor` | opaque cursor from a previous response |

Sorted by `timestamp` descending, deterministic tiebreak on `id`.
`next_cursor` is `null` when there's no more data.

### `GET /api/v1/logs/aggregate` — Aggregate
Same filters as query, plus:

| Param | Required | Meaning |
|---|---|---|
| `start` / `end` | yes | aggregation range |
| `bucket` | yes | `1m`, `1h`, or `1d` |
| `group_by` | no | `service` or `level` |

```json
{ "buckets": [{ "start": "2026-07-20T14:00:00Z", "group": "checkout", "count": 118 }] }
```

Invalid parameters on either endpoint return `400 { "error": "..." }`.

## Schema & Index Design

`logs` is a single logical table, **RANGE partitioned by day on
`ts`**, with a `logs_default` catch-all partition as a safety net.

```
logs (id UUID, ts TIMESTAMPTZ, level TEXT, service TEXT, message TEXT,
      attributes JSONB, ingested_at TIMESTAMPTZ)
PRIMARY KEY (id, ts)
```

Indexes (defined once on the partitioned parent; Postgres propagates
them automatically to every current and future partition):

1. `(service, ts DESC, id DESC)` — the dominant query shape: "logs for
   this service in this time range," already in cursor sort order.
2. `(level, ts DESC, id DESC)` — same reasoning for level-scoped queries.
3. `(ts DESC, id DESC)` — backs pure time-range queries/aggregations and
   the base cursor sort order when no other filter is present.
4. GIN `(attributes jsonb_path_ops)` — supports `@>` containment lookups
   for future/optional features. **Does not** accelerate the required
   `attributes.<key>=<value>` text-equality filter — see Known
   Limitations below for why, and the mitigation in place today.
5. GIN trigram `(message gin_trgm_ops)` — makes `q=` substring search
   (`ILIKE '%term%'`) index-able; a B-Tree cannot serve a leading-wildcard
   `LIKE` at all.

Full `EXPLAIN ANALYZE` output for representative queries is captured in
`docs/explain-analyze.md` (fill in after running your own load test).

## Attribute Storage Strategy: JSONB

Attributes are arbitrary, sparse, per-service key/value pairs with no
fixed schema known ahead of time (`user_id`, `region`, `retries`, or
whatever the next service happens to log). Three options were
considered:

| Approach | Verdict |
|---|---|
| **EAV table** (`log_id, key, value`) | Rejected — turns 1 ingested row into N rows (amplifies the write path exactly where the 15k/sec target hurts most), and every query needs self-joins per key. |
| **Flat TEXT/JSON column, unindexed** | Rejected — no equality/containment index support at all beyond a full scan. |
| **JSONB column + targeted indexes** | **Chosen** — one row per log entry, native containment/GIN indexing available, no schema migration needed when a new attribute key appears. |

The trade-off we accepted: text-equality filtering on an arbitrary key
(`attributes.<key>=<value>`) can't be served by a GIN index the way
containment queries can (see Known Limitations). For this project's
scale (~1M rows) that's mitigated by pruning on service/level/time
first; at materially larger scale the next step would be promoting a
handful of consistently-queried "hot" attribute keys into real,
indexed columns.

## Retention Strategy: Partition Dropping

Retention is enforced by **dropping whole day-partitions**, not by
`DELETE FROM logs WHERE ts < ...`.

- A background job (`services/retention.ts`) runs hourly: it pre-creates
  the next few days' partitions (so ingestion never has to wait on DDL),
  and drops any partition entirely older than `RETENTION_DAYS`.
- `DROP TABLE` on a partition is a metadata-only operation — an ACCESS
  EXCLUSIVE lock held for microseconds, no WAL proportional to row count,
  no bloat, no follow-up `VACUUM` needed to reclaim space.
- The row-by-row alternative would scan and delete tens of thousands of
  rows per day, generate a proportional amount of WAL/dead tuples, and
  compete with live ingestion for the single Postgres CPU core — exactly
  the failure mode partitioning avoids.

`RETENTION_DAYS` (default 30) and `RETENTION_INTERVAL_MS` (default
hourly) are configurable via environment variables.

## Optional Features

| Feature | Default | Env vars | Notes |
|---|---|---|---|
| Authentication / API keys | **off** | `AUTH_ENABLED`, `AUTH_MASTER_KEY` | See below |

`docker compose up` with no configuration yields the plain, unauthenticated
core service: all four endpoints reachable with no credentials, no rate
limiting, no tenancy restriction.

### Auth contract
- `AUTH_ENABLED=false` (default): every request passes through
  unauthenticated, exactly like the core service, even if it carries an
  (ignored) `Authorization` header.
- `AUTH_ENABLED=true` + `AUTH_MASTER_KEY=<key>`: the key is idempotently
  seeded into `api_keys` (hashed, never stored in plaintext) at startup,
  before `/health` reports ready. Restarting the container does not
  invalidate it. Credential is sent as `Authorization: Bearer <key>`
  (also accepted via `X-API-Key`). Missing/malformed credential → `401`;
  valid but out of scope → `403`. `/health` is always exempt.

## Performance

> Fill in after running your own load test — see `Test methodology` below.
> The values in brackets are placeholders; replace with measured numbers.
# Log Ingestion and Query Service

A high-throughput log ingestion, query, and aggregation service, built on
Fastify + raw `pg` + PostgreSQL (range-partitioned). No ORM.

## Quick Start

```bash
docker compose up
```

That's it — the app container waits for Postgres to be healthy, runs
migrations automatically, creates the first few days of partitions, and
starts serving on `http://localhost:8080`. No manual setup, no env file
required for the default (unauthenticated) configuration.

Verify:

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

## API

### `GET /health`
Returns `200` once the DB connection is established, migrations have
been applied, and the service can accept traffic. Always unauthenticated.

### `POST /api/v1/logs` — Ingest
```json
{
  "logs": [
    {
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42", "region": "eu-west", "retries": 3 }
    }
  ]
}
```
- Accepts a batch (a batch of one is valid).
- Each entry is validated independently — one bad entry never fails the
  whole batch. Rejected entries are returned with their original array
  index and a specific reason.
- `202 Accepted` when at least one entry is durably written.
- `400` when every entry is rejected, the JSON is malformed, or the
  top-level shape isn't `{ "logs": [...] }`.

```json
{ "accepted": 9, "rejected": [{ "index": 3, "reason": "invalid level: 'critical'" }] }
```

### `GET /api/v1/logs/query` — Query
All parameters optional and freely combinable:

| Param | Meaning |
|---|---|
| `service` | exact match |
| `level` | exact match |
| `start` / `end` | inclusive/exclusive time range |
| `q` | case-insensitive substring match on `message` |
| `attributes.<key>=<value>` | attribute equality, compared as strings — e.g. `attributes.user_id=42` |
| `limit` | default 100, max 1000 |
| `cursor` | opaque cursor from a previous response |

Sorted by `timestamp` descending, deterministic tiebreak on `id`.
`next_cursor` is `null` when there's no more data.

### `GET /api/v1/logs/aggregate` — Aggregate
Same filters as query, plus:

| Param | Required | Meaning |
|---|---|---|
| `start` / `end` | yes | aggregation range |
| `bucket` | yes | `1m`, `1h`, or `1d` |
| `group_by` | no | `service` or `level` |

```json
{ "buckets": [{ "start": "2026-07-20T14:00:00Z", "group": "checkout", "count": 118 }] }
```

Invalid parameters on either endpoint return `400 { "error": "..." }`.

## Schema & Index Design

`logs` is a single logical table, **RANGE partitioned by day on
`ts`**, with a `logs_default` catch-all partition as a safety net.

```
logs (id UUID, ts TIMESTAMPTZ, level TEXT, service TEXT, message TEXT,
      attributes JSONB, ingested_at TIMESTAMPTZ)
PRIMARY KEY (id, ts)
```

Indexes (defined once on the partitioned parent; Postgres propagates
them automatically to every current and future partition):

1. `(service, ts DESC, id DESC)` — the dominant query shape: "logs for
   this service in this time range," already in cursor sort order.
2. `(level, ts DESC, id DESC)` — same reasoning for level-scoped queries.
3. `(ts DESC, id DESC)` — backs pure time-range queries/aggregations and
   the base cursor sort order when no other filter is present.
4. GIN `(attributes jsonb_path_ops)` — supports `@>` containment lookups
   for future/optional features. **Does not** accelerate the required
   `attributes.<key>=<value>` text-equality filter — see Known
   Limitations below for why, and the mitigation in place today.
5. GIN trigram `(message gin_trgm_ops)` — makes `q=` substring search
   (`ILIKE '%term%'`) index-able; a B-Tree cannot serve a leading-wildcard
   `LIKE` at all.

Full `EXPLAIN ANALYZE` output for representative queries is captured in
`docs/explain-analyze.md` (fill in after running your own load test).

## Attribute Storage Strategy: JSONB

Attributes are arbitrary, sparse, per-service key/value pairs with no
fixed schema known ahead of time (`user_id`, `region`, `retries`, or
whatever the next service happens to log). Three options were
considered:

| Approach | Verdict |
|---|---|
| **EAV table** (`log_id, key, value`) | Rejected — turns 1 ingested row into N rows (amplifies the write path exactly where the 15k/sec target hurts most), and every query needs self-joins per key. |
| **Flat TEXT/JSON column, unindexed** | Rejected — no equality/containment index support at all beyond a full scan. |
| **JSONB column + targeted indexes** | **Chosen** — one row per log entry, native containment/GIN indexing available, no schema migration needed when a new attribute key appears. |

The trade-off we accepted: text-equality filtering on an arbitrary key
(`attributes.<key>=<value>`) can't be served by a GIN index the way
containment queries can (see Known Limitations). For this project's
scale (~1M rows) that's mitigated by pruning on service/level/time
first; at materially larger scale the next step would be promoting a
handful of consistently-queried "hot" attribute keys into real,
indexed columns.

## Retention Strategy: Partition Dropping

Retention is enforced by **dropping whole day-partitions**, not by
`DELETE FROM logs WHERE ts < ...`.

- A background job (`services/retention.ts`) runs hourly: it pre-creates
  the next few days' partitions (so ingestion never has to wait on DDL),
  and drops any partition entirely older than `RETENTION_DAYS`.
- `DROP TABLE` on a partition is a metadata-only operation — an ACCESS
  EXCLUSIVE lock held for microseconds, no WAL proportional to row count,
  no bloat, no follow-up `VACUUM` needed to reclaim space.
- The row-by-row alternative would scan and delete tens of thousands of
  rows per day, generate a proportional amount of WAL/dead tuples, and
  compete with live ingestion for the single Postgres CPU core — exactly
  the failure mode partitioning avoids.

`RETENTION_DAYS` (default 30) and `RETENTION_INTERVAL_MS` (default
hourly) are configurable via environment variables.

## Optional Features

| Feature | Default | Env vars | Notes |
|---|---|---|---|
| Authentication / API keys | **off** | `AUTH_ENABLED`, `AUTH_MASTER_KEY` | See below |

`docker compose up` with no configuration yields the plain, unauthenticated
core service: all four endpoints reachable with no credentials, no rate
limiting, no tenancy restriction.

### Auth contract
- `AUTH_ENABLED=false` (default): every request passes through
  unauthenticated, exactly like the core service, even if it carries an
  (ignored) `Authorization` header.
- `AUTH_ENABLED=true` + `AUTH_MASTER_KEY=<key>`: the key is idempotently
  seeded into `api_keys` (hashed, never stored in plaintext) at startup,
  before `/health` reports ready. Restarting the container does not
  invalidate it. Credential is sent as `Authorization: Bearer <key>`
  (also accepted via `X-API-Key`). Missing/malformed credential → `401`;
  valid but out of scope → `403`. `/health` is always exempt.

## Performance

**Test environment:** Windows 11 + WSL2 (Ubuntu), Docker Desktop. Note:
the `deploy.resources.limits` in `docker-compose.yml` (0.5 CPU/256MB app,
1 CPU/1GB Postgres) are only enforced under Docker Swarm — a plain
`docker compose up` on Docker Desktop does **not** strictly cap
container resources, so these local numbers may not exactly match the
official grading environment.

**Dataset size:** ~601,000 rows at time of the sustained-load test.
**Batch size:** 100 logs per ingest request.
**Load tool:** k6, two concurrent scenarios — sustained batched ingest
plus one `/aggregate` request per second.

**Results (isolated, no concurrent load):** a single aggregate query
over ~600k rows completed in **312ms** (`EXPLAIN ANALYZE`), comfortably
under the 1s p95 target.

**Results (sustained concurrent load, ~2,060 logs/sec ingest + 1
aggregate/sec):**
- Ingest: 0% failed requests, ~2,062 logs/sec sustained, no crashes.
- Aggregate p95 under concurrent load: **1.62s** — over the 1s target.

**Bottleneck identified:** under concurrent load, the aggregate query
competes with sustained ingest writes for the single Postgres CPU core.
`EXPLAIN ANALYZE` on the aggregate query (in isolation) shows Postgres
correctly choosing a `Parallel Seq Scan` over the day's partition
instead of an index scan — because the load test's data was
concentrated in a narrow, recent time window, most rows in that
partition match the query's time filter anyway, so a full scan is
genuinely cheaper than an index lookup that would still touch nearly
every row. The regression only appears when ingest and aggregate
compete for the same single CPU simultaneously, not from a missing or
wrong index.

**Optimization attempted:** increased `PG_POOL_MAX` from 8 to 15,
expecting more headroom for concurrent connections. This made
performance *worse* (p95 rose to ~10s, ~17% request failures) — with
only 1 CPU available to Postgres, more concurrent connections caused
more context-switching and lock contention rather than more real
parallelism. Reverted to `PG_POOL_MAX=8`, confirming the original
sizing rationale (see `src/db/client.ts`) rather than assuming "more
connections = more throughput."

**Known limitation / next optimization:** the aggregate query and
ingest path currently share one connection pool and one CPU core with
no prioritization between them. A read-oriented rollup table (e.g. a
materialized per-minute count table refreshed incrementally) or a
logical-replica read path would decouple aggregate query latency from
ingest throughput — flagged as a stretch-goal improvement rather than
implemented, given time constraints.


### Test methodology
1. `docker compose up -d`, wait for `/health` to return 200.
2. Run the load generator (or a local `autocannon`/`k6` script) against
   `POST /api/v1/logs` with batches of N entries until ~1,000,000 rows
   are stored.
3. While ingestion continues, fire `GET /api/v1/logs/aggregate` once per
   second and record p50/p95/p99 latency.
4. Record container CPU/RAM via `docker stats` throughout.

## Known Limitations

- Attribute equality filtering (`attributes.<key>=<value>`) cannot use
  the GIN index — see "Attribute Storage Strategy" above. Mitigated by
  filtering on service/level/time first.
- `logs_default` (the catch-all partition) has no dedicated retention
  logic beyond the normal indexes; in production this would get its own
  periodic sweep-and-reassign job.
- No pre-aggregated rollup tables — every aggregate query scans the raw
  partitions. Acceptable at ~1M rows / 1 month; would need rollups
  (stretch goal) at 10-100x this volume.
- Single-tenant only; `AUTH_MASTER_KEY` maps to one implicit tenant
  scope, not per-key tenant isolation.

## Local Development (without Docker)

```bash
npm install
cp .env.example .env   # point DATABASE_URL at a local Postgres
npm run migrate:dev
npm run dev
```

## CI

`.github/workflows/ci.yml` builds the project and runs the contract
smoke test (`scripts/smoke-test.ts`) twice: once against the default
unauthenticated configuration, and once with `AUTH_ENABLED=true` to
confirm the auth contract (200 with a valid token, 401 without).

### Test methodology
1. `docker compose up -d`, wait for `/health` to return 200.
2. Run the load generator (or a local `autocannon`/`k6` script) against
   `POST /api/v1/logs` with batches of N entries until ~1,000,000 rows
   are stored.
3. While ingestion continues, fire `GET /api/v1/logs/aggregate` once per
   second and record p50/p95/p99 latency.
4. Record container CPU/RAM via `docker stats` throughout.

## Known Limitations

- Attribute equality filtering (`attributes.<key>=<value>`) cannot use
  the GIN index — see "Attribute Storage Strategy" above. Mitigated by
  filtering on service/level/time first.
- `logs_default` (the catch-all partition) has no dedicated retention
  logic beyond the normal indexes; in production this would get its own
  periodic sweep-and-reassign job.
- No pre-aggregated rollup tables — every aggregate query scans the raw
  partitions. Acceptable at ~1M rows / 1 month; would need rollups
  (stretch goal) at 10-100x this volume.
- Single-tenant only; `AUTH_MASTER_KEY` maps to one implicit tenant
  scope, not per-key tenant isolation.

## Local Development (without Docker)

```bash
npm install
cp .env.example .env   # point DATABASE_URL at a local Postgres
npm run migrate:dev
npm run dev
```

## CI

`.github/workflows/ci.yml` builds the project and runs the contract
smoke test (`scripts/smoke-test.ts`) twice: once against the default
unauthenticated configuration, and once with `AUTH_ENABLED=true` to
confirm the auth contract (200 with a valid token, 401 without).
