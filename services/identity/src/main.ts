import { fileURLToPath } from "node:url";
import { createLogger } from "@shared/commons";
import { OutboxRelay, createPool, runMigrations, waitForDatabase } from "@shared/commons/db";
import { RabbitEventBus } from "@shared/commons/events";
import { runService } from "@shared/commons/http";
import { bootstrapAdmin } from "./admin/service.js";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";
import { KeyStore } from "./crypto/keys.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const KEY_CHECK_INTERVAL_MS = 60 * 60_000;

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

  const keys = new KeyStore({
    pool,
    masterKey: Buffer.from(config.KEY_ENCRYPTION_SECRET, "base64"),
    maxAgeDays: config.SIGNING_KEY_MAX_AGE_DAYS,
    // Una clave retirada se publica el doble de la vida del token de acceso.
    retiredGraceSeconds: config.ACCESS_TOKEN_TTL_SECONDS * 2,
    logger,
  });
  await keys.ensureActiveKey();
  const rotation = setInterval(() => {
    keys
      .ensureActiveKey()
      .catch((error: unknown) => logger.error({ err: error }, "rotación de claves falló"));
  }, KEY_CHECK_INTERVAL_MS);
  rotation.unref();

  if (config.BOOTSTRAP_ADMIN_EMAIL && config.BOOTSTRAP_ADMIN_PASSWORD) {
    const created = await bootstrapAdmin(
      pool,
      config.BOOTSTRAP_ADMIN_EMAIL,
      config.BOOTSTRAP_ADMIN_PASSWORD,
    );
    if (created) logger.warn("administrador inicial creado desde BOOTSTRAP_ADMIN_EMAIL");
  }

  const bus = await RabbitEventBus.connect({
    url: config.AMQP_URL,
    logger,
    connectionName: config.SERVICE_NAME,
  });
  const relay = new OutboxRelay({ pool, publisher: bus, logger });

  const app = buildApp({
    logger,
    pool,
    keys,
    config,
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
      () => bus.close(),
      () => relay.stop(),
      async () => clearInterval(rotation),
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
