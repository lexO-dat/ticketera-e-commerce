import { fileURLToPath } from "node:url";
import { createLogger } from "@shared/commons";
import { createTokenVerifier } from "@shared/commons/auth";
import { OutboxRelay, createPool, runMigrations, waitForDatabase } from "@shared/commons/db";
import { RabbitEventBus } from "@shared/commons/events";
import { createServiceClient, runService } from "@shared/commons/http";
import { createRedis, withLock } from "@shared/commons/redis";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";
import { createOrdersPort } from "./orders-port.js";
import { createWebpayProvider } from "./provider.js";
import { createPaymentService } from "./service.js";

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

  const payments = createPaymentService({
    pool,
    logger,
    provider: createWebpayProvider({
      baseUrl: config.WEBPAY_URL,
      apiKeyId: config.WEBPAY_API_KEY_ID,
      apiKeySecret: config.WEBPAY_API_KEY_SECRET,
      sendMockPayerEmail: config.WEBPAY_SEND_MOCK_PAYER_EMAIL,
      logger,
    }),
    orders: createOrdersPort(
      createServiceClient({
        name: "orders",
        baseUrl: config.ORDERS_URL,
        internalToken: config.INTERNAL_API_TOKEN,
        logger,
      }),
    ),
    returnUrl: config.PAYMENT_RETURN_URL,
    maxAmount: config.MAX_PAYMENT_AMOUNT,
    maxFailedAttemptsPerOrder: config.MAX_ATTEMPTS_PER_ORDER,
    expiryGraceSeconds: config.EXPIRY_GRACE_SECONDS,
  });

  // Jobs con lock distribuido: una sola réplica a la vez (docs/services/payments.md §8).
  const job = (name: string, intervalMs: number, run: () => Promise<number>) => {
    let running = false;
    return setInterval(() => {
      if (running) return;
      running = true;
      withLock(redis, `payments:job:${name}`, intervalMs * 2, run)
        .then((count) => {
          if (count) logger.info({ job: name, count }, "job de pagos procesó intentos");
        })
        .catch((error: unknown) => logger.warn({ err: error, job: name }, "job de pagos falló"))
        .finally(() => {
          running = false;
        });
    }, intervalMs);
  };
  const timers = [
    job("expirer", config.EXPIRER_INTERVAL_MS, () => payments.expireStale()),
    job("reconciler", config.RECONCILER_INTERVAL_MS, () => payments.reconcileUnknown()),
    job("ledger-check", 3_600_000, async () => {
      const check = await payments.ledgerCheck();
      if (!check.balanced) logger.error({ check }, "ALERTA: ledger desbalanceado");
      return 0;
    }),
  ];

  const app = buildApp({
    logger,
    payments,
    verifyToken: createTokenVerifier({ jwksUrl: config.JWKS_URL }),
    internalToken: config.INTERNAL_API_TOKEN,
    webUrl: config.PUBLIC_WEB_URL,
    readinessChecks: {
      postgres: async () => {
        await pool.query("select 1");
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
    onShutdown: [
      () => pool.end(),
      () => redis.quit(),
      () => bus.close(),
      () => relay.stop(),
      async () => timers.forEach((timer) => clearInterval(timer)),
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
