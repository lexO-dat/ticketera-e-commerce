import { fileURLToPath } from "node:url";
import { createLogger } from "@shared/commons";
import { createTokenVerifier } from "@shared/commons/auth";
import { OutboxRelay, createPool, runMigrations, waitForDatabase } from "@shared/commons/db";
import { RabbitEventBus } from "@shared/commons/events";
import { runService } from "@shared/commons/http";
import { createRedis } from "@shared/commons/redis";
import { buildApp } from "./app.js";
import { createReadCache } from "./cache.js";
import { readConfig } from "./config.js";
import { seedDemoData } from "./seed.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const DEMO_SEED_FILE = fileURLToPath(new URL("../seed/demo.sql", import.meta.url));

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
  if (config.SEED_DEMO_DATA) await seedDemoData(pool, DEMO_SEED_FILE, logger);

  const redis = createRedis({ url: config.REDIS_URL, connectionName: config.SERVICE_NAME, logger });
  const bus = await RabbitEventBus.connect({
    url: config.AMQP_URL,
    logger,
    connectionName: config.SERVICE_NAME,
  });
  const relay = new OutboxRelay({ pool, publisher: bus, logger });

  const app = buildApp({
    logger,
    pool,
    cache: createReadCache({ redis, ttlSeconds: config.CACHE_TTL_SECONDS, logger }),
    verifyToken: createTokenVerifier({ jwksUrl: config.JWKS_URL }),
    mediaPublicPath: config.MEDIA_PUBLIC_PATH,
    mediaMaxUploadBytes: config.MEDIA_MAX_UPLOAD_BYTES,
    readinessChecks: {
      postgres: async () => {
        await pool.query("select 1");
      },
      // Sin Redis el catálogo sigue respondiendo desde la BD: no se marca como no listo.
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
