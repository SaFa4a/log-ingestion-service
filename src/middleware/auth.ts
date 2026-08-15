import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { query } from "../db/client.js";

export const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";
const AUTH_MASTER_KEY = process.env.AUTH_MASTER_KEY;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Idempotently seeds AUTH_MASTER_KEY into api_keys at startup, before the
 * service reports healthy. Only the hash is stored — the raw key never
 * touches the database. Safe to call on every restart: ON CONFLICT DO
 * NOTHING means restarting never invalidates the existing key.
 */
export async function seedMasterKey(): Promise<void> {
  if (!AUTH_ENABLED || !AUTH_MASTER_KEY) return;

  await query(
    `INSERT INTO api_keys (key_hash, label, scope)
     VALUES ($1, 'master', 'ingest,query')
     ON CONFLICT (key_hash) DO NOTHING;`,
    [sha256(AUTH_MASTER_KEY)]
  );
}

function extractCredential(req: FastifyRequest): string | null {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  // Secondary transport, contract allows it as long as Bearer always works.
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
    return apiKeyHeader;
  }
  return null;
}

/**
 * Fastify preHandler hook enforcing the auth contract:
 *   - AUTH_ENABLED=false (default): every request passes through untouched,
 *     even if it carries an (unrecognised) Authorization header.
 *   - AUTH_ENABLED=true: a valid credential is required, 401 if missing/
 *     malformed, 403 if valid-but-out-of-scope. Never 500, never 200
 *     with an empty result set on an auth failure.
 */
export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!AUTH_ENABLED) return; // core, unauthenticated behavior

  const credential = extractCredential(req);
  if (!credential) {
    reply.code(401).send({ error: "missing or malformed credential" });
    return reply;
  }

  const { rows } = await query<{ scope: string }>(
    "SELECT scope FROM api_keys WHERE key_hash = $1",
    [sha256(credential)]
  );

  if (rows.length === 0) {
    reply.code(401).send({ error: "missing or malformed credential" });
    return reply;
  }

  const scopes = rows[0]!.scope.split(",");
  const needsIngest = req.method === "POST";
  if (needsIngest && !scopes.includes("ingest")) {
    reply.code(403).send({ error: "insufficient scope" });
    return reply;
  }
  if (!needsIngest && !scopes.includes("query")) {
    reply.code(403).send({ error: "insufficient scope" });
    return reply;
  }
  // Authenticated and in-scope: fall through to the route handler.
}
