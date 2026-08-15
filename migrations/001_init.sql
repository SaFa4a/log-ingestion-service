-- 001_init.sql
-- Core schema for the Log Ingestion and Query Service.
-- Design notes (see README.md for the full reasoning):
--   * logs is RANGE partitioned by day on `ts`. This makes retention a
--     metadata-only DROP TABLE per partition instead of a row-by-row DELETE.
--   * attributes is JSONB. Arbitrary, sparse, per-service key/value data
--     does not have a fixed schema, so a fixed relational shape (EAV or
--     wide table) would either explode in row count or require constant
--     migrations. JSONB gives us flexible storage plus indexable queries.
--   * The primary key must include the partition key (ts), so it is a
--     composite (id, ts) key. `id` is generated with gen_random_uuid()
--     so ingestion never needs a round trip to read back a serial value.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram index for substring search on message

-- ---------------------------------------------------------------------
-- Parent table (partitioned)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logs (
    id          UUID        NOT NULL DEFAULT gen_random_uuid(),
    ts          TIMESTAMPTZ NOT NULL,
    level       TEXT        NOT NULL,
    service     TEXT        NOT NULL,
    message     TEXT        NOT NULL,
    attributes  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, ts),
    CONSTRAINT logs_level_check CHECK (level IN ('debug', 'info', 'warn', 'error'))
) PARTITION BY RANGE (ts);

-- A default partition guarantees inserts never fail with "no partition
-- found" even if the daily-partition maintenance job has fallen behind
-- (e.g. a burst of backdated or slightly-future timestamps). Rows that
-- land here get swept into a real partition by the maintenance job, or
-- simply age out with the default retention sweep. See services/retention.ts.
CREATE TABLE IF NOT EXISTS logs_default PARTITION OF logs DEFAULT;

-- ---------------------------------------------------------------------
-- Indexes on the PARENT table.
-- PostgreSQL (11+) automatically propagates indexes defined on a
-- partitioned parent to every partition, including ones created later.
-- That means the maintenance job only has to CREATE new partitions;
-- it never has to remember to also create indexes on them.
-- ---------------------------------------------------------------------

-- 1) service + time: the most common query shape is
--    "logs for this service in this time range", sorted by ts DESC.
--    id is appended so the (ts, id) pair used by cursor pagination
--    is fully covered without a second sort/lookup.
CREATE INDEX IF NOT EXISTS idx_logs_service_ts
    ON logs (service, ts DESC, id DESC);

-- 2) level + time: same reasoning, for "show me all errors since X".
CREATE INDEX IF NOT EXISTS idx_logs_level_ts
    ON logs (level, ts DESC, id DESC);

-- 3) A plain time index covers queries/aggregations that filter or
--    group only by time range (no service/level predicate), and backs
--    the base sort order used by cursor pagination when no other
--    filter is present.
CREATE INDEX IF NOT EXISTS idx_logs_ts
    ON logs (ts DESC, id DESC);

-- 4) GIN index over attributes, for @> containment-style lookups.
--    NOTE: the required API's attribute filter is defined as "equality,
--    compared as strings" (attributes->>'key' = 'value' as TEXT,
--    regardless of the JSON value's underlying type). Postgres cannot
--    use a GIN jsonb index to accelerate ->> text-extraction equality
--    on an arbitrary, caller-supplied key — GIN here only accelerates
--    @> containment / ?/?|/?& existence checks. We keep this index
--    because it is still valuable for potential future/optional
--    features (e.g. an admin containment-search endpoint), and because
--    it costs little on writes relative to what it would unlock. The
--    attribute equality filter itself relies on first narrowing by
--    service/level/time (all indexed) before evaluating the ->>
--    predicate on the shrunk row set. See README "Known limitations".
CREATE INDEX IF NOT EXISTS idx_logs_attributes_gin
    ON logs USING GIN (attributes jsonb_path_ops);

-- 5) Trigram index on message for fast case-insensitive ILIKE '%term%'
--    substring search. A plain B-Tree cannot serve a leading-wildcard
--    LIKE; pg_trgm breaks the string into 3-character fragments that
--    CAN be indexed, at the cost of extra index size and slower writes.
CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
    ON logs USING GIN (message gin_trgm_ops);

-- ---------------------------------------------------------------------
-- API keys (used only when AUTH_ENABLED=true)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash    TEXT UNIQUE NOT NULL,   -- sha256 of the raw key, never store plaintext
    label       TEXT NOT NULL DEFAULT 'master',
    scope       TEXT NOT NULL DEFAULT 'ingest,query',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Bookkeeping table so the partition-maintenance job knows, without
-- scanning pg_class, what it has already created/dropped.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logs_partitions (
    partition_name TEXT PRIMARY KEY,
    range_start    DATE NOT NULL,
    range_end      DATE NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
