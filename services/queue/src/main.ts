import { createLogger } from "@shared/commons";
import { createTokenVerifier } from "@shared/commons/auth";
import { RabbitEventBus } from "@shared/commons/events";
import { runService } from "@shared/commons/http";
import { createRedis } from "@shared/commons/redis";
import { buildApp } from "./app.js";
import { configFromCatalogEvent } from "./catalog-events.js";
import { readConfig } from "./config.js";
import { createEventConfigSource } from "./event-config.js";
import { createQueueService } from "./queue.js";
import { createAdmissionSigner } from "./tokens.js";

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });

  const redis = createRedis({ url: config.REDIS_URL, connectionName: config.SERVICE_NAME, logger });
  const bus = await RabbitEventBus.connect({
    url: config.AMQP_URL,
    logger,
    connectionName: config.SERVICE_NAME,
  });
  const signer = await createAdmissionSigner(
    config.ADMISSION_SIGNING_KEY,
    config.ADMISSION_SIGNING_KID,
  );
  const configs = createEventConfigSource({
    redis,
    catalogUrl: config.CATALOG_URL,
    ttlSeconds: config.CONFIG_CACHE_SECONDS,
    logger,
  });
  const queue = createQueueService({
    redis,
    configs,
    signer,
    publisher: bus,
    logger,
    heartbeatTimeoutSeconds: config.HEARTBEAT_TIMEOUT_SECONDS,
  });

  // Cambios de configuración de la fila desde catalog, sin esperar al TTL de la caché.
  await bus.subscribe({
    queue: "queue.catalog-events",
    bindings: ["catalog.EventoActualizado.*", "catalog.EventoEliminado.*"],
    handler: async (event) => {
      const next = configFromCatalogEvent(event);
      if (next) await configs.apply(next);
    },
  });

  // Admisor: corre en todas las réplicas; por evento actúa solo la líder (lock en Redis).
  let ticking = false;
  const admitter = setInterval(() => {
    if (ticking) return;
    ticking = true;
    queue
      .tick()
      .catch((error: unknown) => logger.warn({ err: error }, "admisor: ciclo falló"))
      .finally(() => {
        ticking = false;
      });
  }, config.ADMIT_INTERVAL_MS);

  const app = buildApp({
    logger,
    queue,
    signer,
    verifyToken: createTokenVerifier({ jwksUrl: config.JWKS_URL }),
    readinessChecks: {
      redis: async () => {
        await redis.ping();
      },
      rabbitmq: async () => {
        if (!bus.isConnected) throw new Error("sin conexión");
      },
    },
  });

  await runService({
    app,
    host: config.HOST,
    port: config.PORT,
    logger,
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    onShutdown: [
      () => redis.quit(),
      () => bus.close(),
      () => queue.stop(),
      async () => clearInterval(admitter),
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
