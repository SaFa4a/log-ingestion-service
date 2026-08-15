import "dotenv/config";
import Fastify from "fastify";
import { runMigrations } from "./db/migrate.js";
import { checkConnection, shutdownPool } from "./db/client.js";
import { seedMasterKey } from "./middleware/auth.js";
import { startRetentionScheduler, stopRetentionScheduler } from "./services/retention.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerIngestRoute } from "./routes/ingest.js";
import { registerQueryRoute } from "./routes/query.js";
import { registerAggregateRoute } from "./routes/aggregate.js";

const PORT = Number(process.env.PORT ?? 8080);

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 2 * 1024 * 1024,
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const statusCode = err.statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({ error: err.message || "bad request" });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: "internal server error" });
  });

  let ready = false;
  registerHealthRoute(app, () => ready);
  registerIngestRoute(app);
  registerQueryRoute(app);
  registerAggregateRoute(app);

  await app.listen({ port: PORT, host: "0.0.0.0" });

  const dbUp = await waitForDatabase();
  if (!dbUp) {
    app.log.error("database never became reachable — exiting");
    process.exit(1);
  }

  await runMigrations();
  await seedMasterKey();
  startRetentionScheduler();

  ready = true;
  app.log.info(`log-ingestion-service ready on :${PORT}`);

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    ready = false;
    stopRetentionScheduler();
    await app.close();
    await shutdownPool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function waitForDatabase(retries = 30, delayMs = 1000): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    if (await checkConnection()) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

main().catch((err) => {
  console.error("fatal startup error", err);
  process.exit(1);
});