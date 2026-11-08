import { createLogger } from "@shared/commons";
import { createAdmissionVerifier, createTokenVerifier } from "@shared/commons/auth";
import { runService } from "@shared/commons/http";
import { createRedis } from "@shared/commons/redis";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";
import { replicatedJwks } from "./jwks.js";

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });
  const redis = createRedis({ url: config.REDIS_URL, connectionName: config.SERVICE_NAME, logger });

  const app = await buildApp({
    logger,
    config,
    redis,
    verifyToken: createTokenVerifier({ getKey: replicatedJwks(config.IDENTITY_URLS) }),
    verifyAdmission: createAdmissionVerifier({
      jwksUrl: new URL("/.well-known/jwks.json", config.QUEUE_URLS[0]),
    }),
    // El gateway sigue "listo" aunque un servicio caiga: responde 503 solo en sus rutas.
    readinessChecks: {
      redis: async () => {
        await redis.ping();
      },
    },
  });

  await runService({
    app,
    host: config.HOST,
    port: config.PORT,
    logger,
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    onShutdown: [() => redis.quit()],
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
