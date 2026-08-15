import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pool, { query } from "./client.js";
import { ensurePartitionsAhead } from "../services/retention.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const result = await query<{ filename: string }>(
    "SELECT filename FROM schema_migrations"
  );
  return new Set(result.rows.map((r) => r.filename));
}

/**
 * Applies every .sql file in /migrations, in filename order, exactly once.
 * Idempotent: safe to run on every container start. This is what makes
 * `docker compose up` "just work" with no manual migration step.
 */
export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const already = await appliedMigrations();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (already.has(file)) continue;

    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file]
      );
      await client.query("COMMIT");
      // eslint-disable-next-line no-console
      console.log(`applied migration: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  // Make sure today's and the next few days' partitions exist before we
  // ever accept traffic — otherwise the very first ingest request could
  // race the retention job's daily cron.
  await ensurePartitionsAhead(3);
}

// Allow `node dist/db/migrate.js` to run migrations standalone (used by
// the CI smoke test and by anyone debugging migrations directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log("migrations complete");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
