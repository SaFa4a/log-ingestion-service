import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  QueryValidationError,
  parseLevel,
  parseLimit,
  parseTimestamp,
  runQuery,
} from "../services/logQueryService.js";
import { requireAuth } from "../middleware/auth.js";

// Attribute filters are supplied as `attributes.<key>=<value>`, e.g.
// `?attributes.user_id=42&attributes.region=eu-west`. This namespaced
// convention lets us support an arbitrary, caller-chosen set of keys
// without colliding with the fixed query parameters (service, level,
// start, end, q, limit, cursor).
function extractAttributeFilters(
  raw: FastifyRequest["query"]
): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith("attributes.") && typeof value === "string") {
      attrs[key.slice("attributes.".length)] = value;
    }
  }
  return attrs;
}

export function registerQueryRoute(app: FastifyInstance): void {
  app.get(
    "/api/v1/logs/query",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = req.query as Record<string, unknown>;

      try {
        const start = parseTimestamp(q.start, "start");
        const end = parseTimestamp(q.end, "end");
        if (start && end && new Date(end) <= new Date(start)) {
          throw new QueryValidationError("'end' must be later than 'start'");
        }

        const filters = {
          service: typeof q.service === "string" ? q.service : undefined,
          level: parseLevel(q.level),
          start,
          end,
          q: typeof q.q === "string" ? q.q : undefined,
          attributes: extractAttributeFilters(q),
          limit: parseLimit(q.limit),
          cursor: typeof q.cursor === "string" ? q.cursor : undefined,
        };

        const result = await runQuery(filters);
        reply.code(200);
        return result;
      } catch (err) {
        if (err instanceof QueryValidationError) {
          reply.code(400);
          return { error: err.message };
        }
        throw err;
      }
    }
  );
}
