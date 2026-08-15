import type { FastifyInstance } from "fastify";

/**
 * /health is always unauthenticated (per the auth contract) and always
 * registered — it must be reachable before the load generator has any
 * credentials. `isReady()` flips to true only after migrations have run
 * and a DB ping has succeeded (see server.ts), so a container that is
 * still starting up correctly fails its health check instead of
 * accepting traffic it can't serve.
 */
export function registerHealthRoute(
  app: FastifyInstance,
  isReady: () => boolean
): void {
  app.get("/health", async (_req, reply) => {
    if (!isReady()) {
      reply.code(503);
      return { status: "starting" };
    }
    reply.code(200);
    return { status: "ok" };
  });
}
