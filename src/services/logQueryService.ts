import { query } from "../db/client.js";
import { decodeCursor, encodeCursor } from "../utils/cursor.js";
import type { LogLevel } from "../validation/logSchema.js";

export interface LogRow {
  id: string;
  ts: string;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, unknown>;
}

export interface QueryFilters {
  service?: string;
  level?: string;
  start?: string;
  end?: string;
  q?: string;
  attributes?: Record<string, string>;
  limit: number;
  cursor?: string;
}

export interface QueryResult {
  logs: {
    id: string;
    timestamp: string;
    level: string;
    service: string;
    message: string;
    attributes: Record<string, unknown>;
  }[];
  next_cursor: string | null;
}

export class QueryValidationError extends Error {}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Every predicate here is built with a numbered placeholder ($1, $2, ...)
 * appended to a `params` array — never string-interpolated. This is the
 * single rule that keeps this whole query builder immune to SQL
 * injection even though the filter set is fully dynamic.
 */
export async function runQuery(filters: QueryFilters): Promise<QueryResult> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const addClause = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };

  if (filters.service) addClause("service = ?", filters.service);
  if (filters.level) addClause("level = ?", filters.level);
  if (filters.start) addClause("ts >= ?", filters.start);
  if (filters.end) addClause("ts < ?", filters.end);
  if (filters.q) addClause("message ILIKE ?", `%${filters.q}%`);

  if (filters.attributes) {
    for (const [key, value] of Object.entries(filters.attributes)) {
      // Contract requires attribute equality to be "compared as strings":
      // whatever type the value was stored as (number/string/boolean),
      // extract it as text with ->> and compare to the query string as
      // text. This is a deliberate correctness-over-speed trade-off — see
      // the note above idx_logs_attributes_gin and the README's "Known
      // limitations" section for why this predicate can't use that GIN
      // index (GIN accelerates @> containment, not ->> text equality on
      // an arbitrary caller-supplied key), and how it's mitigated by
      // filtering on service/level/time first to shrink the row set
      // before this predicate is ever evaluated.
      params.push(key, value);
      clauses.push(`attributes ->> $${params.length - 1} = $${params.length}`);
    }
  }

  let cursor: { ts: string; id: string } | null = null;
  if (filters.cursor) {
    cursor = decodeCursor(filters.cursor);
    if (!cursor) throw new QueryValidationError("invalid or malformed cursor");
    // Keyset predicate: strictly older than the last row of the previous
    // page, using the same (ts DESC, id DESC) order the index provides.
    params.push(cursor.ts, cursor.id);
    clauses.push(
      `(ts, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
    );
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  // Fetch one extra row to know whether a next page exists without a
  // separate COUNT(*) query.
  params.push(filters.limit + 1);
  const limitParamIndex = params.length;

  const sql = `
    SELECT id, ts, level, service, message, attributes
    FROM logs
    ${whereSql}
    ORDER BY ts DESC, id DESC
    LIMIT $${limitParamIndex};
  `;

  const { rows } = await query<LogRow>(sql, params);

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  const last = page[page.length - 1];
  const next_cursor =
    hasMore && last ? encodeCursor({ ts: last.ts, id: last.id }) : null;

  return {
    logs: page.map((row) => ({
      id: row.id,
      timestamp: new Date(row.ts).toISOString(),
      level: row.level,
      service: row.service,
      message: row.message,
      attributes: row.attributes,
    })),
    next_cursor,
  };
}

export function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new QueryValidationError("limit must be an integer");
  }
  if (n < 1 || n > MAX_LIMIT) {
    throw new QueryValidationError(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return n;
}

export function parseLevel(raw: unknown): LogLevel | undefined {
  if (raw === undefined) return undefined;
  const levels = ["debug", "info", "warn", "error"];
  if (typeof raw !== "string" || !levels.includes(raw)) {
    throw new QueryValidationError(`unsupported log level: '${String(raw)}'`);
  }
  return raw as LogLevel;
}

export function parseTimestamp(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    throw new QueryValidationError(`invalid timestamp for '${field}'`);
  }
  return new Date(raw).toISOString();
}

// ---------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------

export type BucketSize = "1m" | "1h" | "1d";

const BUCKET_SECONDS: Record<BucketSize, number> = {
  "1m": 60,
  "1h": 3600,
  "1d": 86400,
};

export interface AggregateFilters {
  service?: string;
  level?: string;
  attributes?: Record<string, string>;
  q?: string;
  start: string;
  end: string;
  bucket: BucketSize;
  groupBy?: "service" | "level";
}

export interface AggregateBucket {
  start: string;
  group: string | null;
  count: number;
}

/**
 * Time-bucketed counts. Bucketing is done with to_timestamp(floor(...))
 * rather than date_trunc, because date_trunc only supports fixed
 * calendar units (minute/hour/day) whereas floor-division works
 * identically for any bucket width — this keeps 1m/1h/1d on one code
 * path and makes adding e.g. "5m" later a one-line change.
 */
export async function runAggregate(
  filters: AggregateFilters
): Promise<AggregateBucket[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const addClause = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };

  addClause("ts >= ?", filters.start);
  addClause("ts < ?", filters.end);
  if (filters.service) addClause("service = ?", filters.service);
  if (filters.level) addClause("level = ?", filters.level);
  if (filters.q) addClause("message ILIKE ?", `%${filters.q}%`);
  if (filters.attributes) {
    for (const [key, value] of Object.entries(filters.attributes)) {
      params.push(key, value);
      clauses.push(`attributes ->> $${params.length - 1} = $${params.length}`);
    }
  }

  const bucketSeconds = BUCKET_SECONDS[filters.bucket];
  params.push(bucketSeconds);
  const bucketParamIndex = params.length;

  const groupExpr = filters.groupBy === "level" ? "level" : "service";
  const selectGroup = filters.groupBy ? `${groupExpr} AS grp,` : `NULL AS grp,`;
  const groupBySql = filters.groupBy ? `, ${groupExpr}` : "";

  const sql = `
    SELECT
      to_timestamp(floor(extract(epoch FROM ts) / $${bucketParamIndex}) * $${bucketParamIndex})
        AS bucket_start,
      ${selectGroup}
      count(*)::int AS count
    FROM logs
    WHERE ${clauses.join(" AND ")}
    GROUP BY bucket_start${groupBySql}
    ORDER BY bucket_start ASC;
  `;

  const { rows } = await query<{
    bucket_start: string;
    grp: string | null;
    count: number;
  }>(sql, params);

  return rows.map((row) => ({
    start: new Date(row.bucket_start).toISOString(),
    group: filters.groupBy ? row.grp : null,
    count: row.count,
  }));
}
