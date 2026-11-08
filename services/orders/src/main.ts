import { fileURLToPath } from "node:url";
import { createLogger } from "@shared/commons";
import { createTokenVerifier } from "@shared/commons/auth";
import { OutboxRelay, createPool, runMigrations, waitForDatabase } from "@shared/commons/db";
import { RabbitEventBus } from "@shared/commons/events";
import { createServiceClient, runService } from "@shared/commons/http";
import { createRedis, withLock } from "@shared/commons/redis";
import { buildApp } from "./app.js";
import { createCart } from "./cart.js";
import { readConfig } from "./config.js";
import { PAYMENT_SUBSCRIPTION, handlePaymentEvent } from "./payment-events.js";
import { httpCatalog, httpInventory, httpPayments } from "./ports.js";
import { seedDemoData } from "./seed.js";
import { createOrderService } from "./service.js";

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

  const client = (name: string, baseUrl: string) =>
    createServiceClient({ name, baseUrl, internalToken: config.INTERNAL_API_TOKEN, logger });
  const cart = createCart(redis, config.CART_TTL_SECONDS);
  const orders = createOrderService({
    pool,
    cart,
    logger,
    inventory: httpInventory(client("inventory", config.INVENTORY_URL)),
    catalog: httpCatalog(client("catalog", config.CATALOG_URL)),
    payments: httpPayments(client("payments", config.PAYMENTS_URL)),
  });

  await bus.subscribe({
    ...PAYMENT_SUBSCRIPTION,
    handler: (event) => handlePaymentEvent(pool, orders, event),
  });

  let expiring = false;
  const expirer = setInterval(() => {
    if (expiring) return;
    expiring = true;
    withLock(redis, "orders:job:expirer", 120_000, () => orders.expireStale())
      .catch((error: unknown) => logger.warn({ err: error }, "expirador de órdenes falló"))
      .finally(() => {
        expiring = false;
      });
  }, 60_000);

  const app = buildApp({
    logger,
    orders,
    cart,
    verifyToken: createTokenVerifier({ jwksUrl: config.JWKS_URL }),
    internalToken: config.INTERNAL_API_TOKEN,
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
    onShutdown: [
      () => pool.end(),
      () => redis.quit(),
      () => bus.close(),
      () => relay.stop(),
      async () => clearInterval(expirer),
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
