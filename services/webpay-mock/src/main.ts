import { createLogger } from "@shared/commons";
import { runService } from "@shared/commons/http";
import { createRedis } from "@shared/commons/redis";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });
  const redis = createRedis({ url: config.REDIS_URL, connectionName: config.SERVICE_NAME, logger });
  const app = buildApp({
    logger,
    redis,
    ttlSeconds: config.TRANSACTION_TTL_SECONDS,
    options: {
      apiKeyId: config.WEBPAY_API_KEY_ID,
      apiKeySecret: config.WEBPAY_API_KEY_SECRET,
      formUrl: config.WEBPAY_FORM_URL,
      defaultOutcome: config.WEBPAY_MOCK_DEFAULT_OUTCOME,
      latencyMs: config.WEBPAY_MOCK_LATENCY_MS,
      commitLossRatio: config.WEBPAY_MOCK_COMMIT_LOSS_RATIO,
      errorRatio: config.WEBPAY_MOCK_ERROR_RATIO,
    },
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
