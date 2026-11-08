import { fileURLToPath } from "node:url";
import { createLogger } from "@shared/commons";
import { createAdmissionVerifier, createTokenVerifier } from "@shared/commons/auth";
import { OutboxRelay, createPool, runMigrations, waitForDatabase } from "@shared/commons/db";
import { RabbitEventBus } from "@shared/commons/events";
import { runService } from "@shared/commons/http";
import { createRedis, withLock } from "@shared/commons/redis";
import { buildApp } from "./app.js";
import { createCatalogClient } from "./catalog-client.js";
import { CATALOG_SUBSCRIPTION, handleCatalogEvent } from "./catalog-events.js";
import { readConfig } from "./config.js";

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
  await bus.subscribe({
    ...CATALOG_SUBSCRIPTION,
    handler: (event) => handleCatalogEvent(pool, event),
  });

  const { app, reservations } = buildApp({
    logger,
    pool,
    redis,
    catalog: createCatalogClient({ baseUrl: config.CATALOG_URL, logger }),
    verifyToken: createTokenVerifier({ jwksUrl: config.JWKS_URL }),
    verifyAdmission: createAdmissionVerifier({ jwksUrl: config.QUEUE_JWKS_URL }),
    reservationTtlSeconds: config.RESERVATION_TTL_SECONDS,
    availabilityCacheMs: config.AVAILABILITY_CACHE_MS,
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

  // Barrido de reservas vencidas: una réplica a la vez (lock en Redis).
  let sweeping = false;
  const sweeper = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    withLock(redis, "inventory:sweeper", config.SWEEP_INTERVAL_MS * 5, () => reservations.sweep())
      .then((expired) => {
        if (expired) logger.info({ expired }, "reservas vencidas liberadas");
      })
      .catch((error: unknown) => logger.warn({ err: error }, "barrido de reservas falló"))
      .finally(() => {
        sweeping = false;
      });
  }, config.SWEEP_INTERVAL_MS);

  relay.start();
  await runService({
    app,
    host: config.HOST,
    port: config.PORT,
    logger,
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    onShutdown: [
      () => pool.end(),
      () => redis.quit(),
      () => bus.close(),
      () => relay.stop(),
      async () => clearInterval(sweeper),
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
