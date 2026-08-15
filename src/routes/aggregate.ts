import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  QueryValidationError,
  parseLevel,
  parseTimestamp,
  runAggregate,
  type BucketSize,
} from "../services/logQueryService.js";
import { requireAuth } from "../middleware/auth.js";

const VALID_BUCKETS: BucketSize[] = ["1m", "1h", "1d"];

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

export function registerAggregateRoute(app: FastifyInstance): void {
  app.get(
    "/api/v1/logs/aggregate",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = req.query as Record<string, unknown>;

      try {
        const start = parseTimestamp(q.start, "start");
        const end = parseTimestamp(q.end, "end");
        if (!start) throw new QueryValidationError("'start' is required");
        if (!end) throw new QueryValidationError("'end' is required");
        if (new Date(end) <= new Date(start)) {
          throw new QueryValidationError("'end' must be later than 'start'");
        }

        if (typeof q.bucket !== "string" || !VALID_BUCKETS.includes(q.bucket as BucketSize)) {
          throw new QueryValidationError("bucket must be one of: 1m, 1h, 1d");
        }

        let groupBy: "service" | "level" | undefined;
        if (q.group_by !== undefined) {
          if (q.group_by !== "service" && q.group_by !== "level") {
            throw new QueryValidationError("group_by must be 'service' or 'level'");
          }
          groupBy = q.group_by;
        }

        const buckets = await runAggregate({
          service: typeof q.service === "string" ? q.service : undefined,
          level: parseLevel(q.level),
          q: typeof q.q === "string" ? q.q : undefined,
          attributes: extractAttributeFilters(q),
          start,
          end,
          bucket: q.bucket as BucketSize,
          groupBy,
        });

        reply.code(200);
        return { buckets };
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
