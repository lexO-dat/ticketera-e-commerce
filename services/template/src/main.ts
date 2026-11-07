import { fileURLToPath } from "node:url";
import { createLogger } from "@shared/commons";
import { OutboxRelay, createPool, runMigrations, waitForDatabase } from "@shared/commons/db";
import { RabbitEventBus } from "@shared/commons/events";
import { runService } from "@shared/commons/http";
import { createRedis } from "@shared/commons/redis";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";
import { createNotesService } from "./notes/service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    applicationName: config.SERVICE_NAME,
    max: config.DB_POOL_MAX,
    logger,
  });
  await waitForDatabase(pool);
  await runMigrations(pool, MIGRATIONS_DIR, logger);

  const redis = createRedis({ url: config.REDIS_URL, connectionName: config.SERVICE_NAME, logger });
  const bus = await RabbitEventBus.connect({
    url: config.AMQP_URL,
    logger,
    connectionName: config.SERVICE_NAME,
  });
  const relay = new OutboxRelay({ pool, publisher: bus, logger });

  const app = buildApp({
    serviceName: config.SERVICE_NAME,
    logger,
    notes: createNotesService(pool),
    readinessChecks: {
      postgres: async () => {
        await pool.query("select 1");
      },
      redis: async () => {
        await redis.ping();
      },
      rabbitmq: async () => {
        if (!bus.isConnected) throw new Error("sin conexión");
      },
    },
  });

  relay.start();
  await runService({
    app,
    host: config.HOST,
    port: config.PORT,
    logger,
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    // Se cierran en orden inverso: primero el relay, al final la BD.
    onShutdown: [() => pool.end(), () => redis.quit(), () => bus.close(), () => relay.stop()],
  });
}

main().catch((error: unknown) => {
  // El logger puede no existir aún (configuración inválida): stderr directo.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
