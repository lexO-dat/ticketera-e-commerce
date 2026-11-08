import { fileURLToPath } from "node:url";
import { createLogger } from "@shared/commons";
import { createTokenVerifier } from "@shared/commons/auth";
import { OutboxRelay, createPool, runMigrations, waitForDatabase } from "@shared/commons/db";
import { RabbitEventBus } from "@shared/commons/events";
import { createServiceClient, runService } from "@shared/commons/http";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";
import { ORDER_SUBSCRIPTION, handleOrderEvent } from "./order-events.js";
import { createTicketQr } from "./qr.js";
import { catalogSeatLabels } from "./seats.js";
import { createTicketService } from "./service.js";

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
  const bus = await RabbitEventBus.connect({
    url: config.AMQP_URL,
    logger,
    connectionName: config.SERVICE_NAME,
  });
  const relay = new OutboxRelay({ pool, publisher: bus, logger });

  const qr = await createTicketQr(config.TICKET_SIGNING_KEY, config.TICKET_SIGNING_KID);
  const tickets = createTicketService({
    pool,
    qr,
    logger,
    seats: catalogSeatLabels(
      createServiceClient({ name: "catalog", baseUrl: config.CATALOG_URL, logger }),
    ),
  });
  await bus.subscribe({
    ...ORDER_SUBSCRIPTION,
    handler: (event) => handleOrderEvent(pool, tickets, event),
  });

  const app = buildApp({
    logger,
    tickets,
    qr,
    verifyToken: createTokenVerifier({ jwksUrl: config.JWKS_URL }),
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
    onShutdown: [() => pool.end(), () => bus.close(), () => relay.stop()],
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
