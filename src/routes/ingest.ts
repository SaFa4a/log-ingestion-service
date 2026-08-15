import type { FastifyInstance } from "fastify";
import { ingestBodySchema, validateBatch } from "../validation/logSchema.js";
import { insertBatch } from "../services/logIngestService.js";
import { requireAuth } from "../middleware/auth.js";

export function registerIngestRoute(app: FastifyInstance): void {
  app.post(
    "/api/v1/logs",
    { preHandler: requireAuth },
    async (req, reply) => {
      // Malformed JSON never reaches here — Fastify's body parser
      // rejects it before the handler runs (see server.ts contentTypeParser
      // error handling), landing in the generic 400 handler.
      const parsedBody = ingestBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        reply.code(400);
        return { error: "request body must be a JSON object with a non-empty 'logs' array" };
      }

      const { accepted, rejected } = validateBatch(parsedBody.data.logs);

      if (accepted.length === 0) {
        // All entries rejected: nothing durable happened, so 400 is
        // correct — but we still return the full accepted/rejected
        // shape (rather than a bare {error}) because the per-index
        // reasons are exactly what a caller needs to fix their batch.
        reply.code(400);
        return { accepted: 0, rejected };
      }

      const insertedCount = await insertBatch(accepted);

      // 202 Accepted: durably written, at least partially. Never send
      // this before the INSERT has completed — the contract explicitly
      // forbids reporting success for data we haven't durably accepted.
      reply.code(202);
      return { accepted: insertedCount, rejected };
    }
  );
}
