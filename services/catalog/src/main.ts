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
import { METRICS_SUBSCRIPTION, createMetricsService } from "./metrics/service.js";
import { seedDemoImages } from "./demo-art.js";
import { createMediaService } from "./media/service.js";
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
  const cache = createReadCache({ redis, ttlSeconds: config.CACHE_TTL_SECONDS, logger });
  if (config.SEED_DEMO_DATA) {
    // Portadas propias para los datos de demostración (el prototipo no traía imágenes).
    const media = createMediaService({ pool, publicPath: config.MEDIA_PUBLIC_PATH });
    await seedDemoImages({ pool, media, cache, logger }).catch((error: unknown) =>
      logger.warn({ err: error }, "no se pudieron generar las portadas de demostración"),
    );
  }
  const bus = await RabbitEventBus.connect({
    url: config.AMQP_URL,
    logger,
    connectionName: config.SERVICE_NAME,
  });
  const relay = new OutboxRelay({ pool, publisher: bus, logger });

  // Embudo de ventas: vistas acumuladas en Redis y volcadas en lotes; el resto, por eventos.
  const metrics = createMetricsService({ pool, redis });
  await bus.subscribe({ ...METRICS_SUBSCRIPTION, handler: (event) => metrics.handleEvent(event) });
  let flushing = false;
  const flusher = setInterval(() => {
    if (flushing) return;
    flushing = true;
    metrics
      .flushViews()
      .catch((error: unknown) => logger.warn({ err: error }, "no se pudieron volcar las vistas"))
      .finally(() => {
        flushing = false;
      });
  }, config.METRICS_FLUSH_SECONDS * 1000);

  const app = buildApp({
    logger,
    pool,
    cache,
    verifyToken: createTokenVerifier({ jwksUrl: config.JWKS_URL }),
    mediaPublicPath: config.MEDIA_PUBLIC_PATH,
    mediaMaxUploadBytes: config.MEDIA_MAX_UPLOAD_BYTES,
    metrics,
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
    onShutdown: [
      () => pool.end(),
      () => redis.quit(),
      () => bus.close(),
      () => relay.stop(),
      // Último volcado antes de cerrar Redis y la BD.
      async () => {
        clearInterval(flusher);
        await metrics.flushViews().catch(() => 0);
      },
    ],
  });
}

main().catch((error: unknown) => {
  // El logger puede no existir aún (configuración inválida): stderr directo.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
