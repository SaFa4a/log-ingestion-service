import { query } from "../db/client.js";
import type { ValidatedLog } from "../validation/logSchema.js";

/**
 * Inserts an entire validated batch in a single round trip using
 * UNNEST over parallel arrays, instead of either:
 *   (a) one INSERT per row — N round trips, N times the network/parse
 *       overhead, completely unworkable at 15k+ rows/sec on 0.5 CPU, or
 *   (b) a single INSERT ... VALUES (...), (...), (...) with thousands
 *       of literal placeholders — works, but building and parsing a
 *       multi-thousand-parameter SQL string is itself non-trivial CPU
 *       and defeats prepared-statement plan caching (every batch size
 *       is a different SQL string).
 * UNNEST keeps the SQL text constant regardless of batch size (it's
 * always the same 6 arrays), so Postgres can cache one query plan and
 * reuse it for every batch, while still sending all rows in one
 * round trip.
 */
export async function insertBatch(logs: ValidatedLog[]): Promise<number> {
  if (logs.length === 0) return 0;

  const ts = logs.map((l) => l.timestamp);
  const level = logs.map((l) => l.level);
  const service = logs.map((l) => l.service);
  const message = logs.map((l) => l.message);
  const attributes = logs.map((l) => JSON.stringify(l.attributes));

  const sql = `
    INSERT INTO logs (ts, level, service, message, attributes)
    SELECT * FROM unnest(
      $1::timestamptz[],
      $2::text[],
      $3::text[],
      $4::text[],
      $5::jsonb[]
    );
  `;

  const result = await query(sql, [ts, level, service, message, attributes]);
  return result.rowCount ?? 0;
}
