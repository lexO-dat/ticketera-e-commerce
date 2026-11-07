/**
 * Pruebas de integración contra Postgres, Redis y RabbitMQ reales.
 * Se activan con TEST_DATABASE_URL, TEST_REDIS_URL y TEST_AMQP_URL (ver `npm run infra:up` y
 * `packages/commons/README.md`); sin ellas se omiten.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MigrationError,
  OUTBOX_INBOX_SQL,
  OutboxRelay,
  createPool,
  enqueueOutbox,
  markProcessed,
  runMigrations,
  withTransaction,
  type Pool,
} from "../src/db/index.js";
import { type EventEnvelope, RabbitEventBus, createEvent } from "../src/events/index.js";
import { createLogger } from "../src/logger.js";
import { acquireLock, createRedis, withLock, type Redis } from "../src/redis/index.js";
import { newId } from "../src/ids.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const AMQP_URL = process.env.TEST_AMQP_URL;
const logger = createLogger({ service: "commons-test", level: "silent" });

describe.skipIf(!DATABASE_URL)("postgres", () => {
  let pool: Pool;
  const schema = `test_${newId().replaceAll("-", "").slice(0, 12)}`;

  beforeAll(async () => {
    const admin = createPool({ connectionString: DATABASE_URL!, applicationName: "commons-test" });
    await admin.query(`create schema ${schema}`);
    await admin.end();
    // Cada ejecución en su propio esquema: las pruebas no se pisan entre sí.
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ connectionString: url.toString(), applicationName: "commons-test" });
  });

  afterAll(async () => {
    await pool?.query(`drop schema if exists ${schema} cascade`);
    await pool?.end();
  });

  it("aplica migraciones una vez y detecta migraciones modificadas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrations-"));
    try {
      await writeFile(join(dir, "0001_outbox_inbox.sql"), OUTBOX_INBOX_SQL);
      await writeFile(
        join(dir, "0002_seats.sql"),
        "create table seats (id int primary key, sold boolean not null default false);",
      );
      const first = await runMigrations(pool, dir);
      expect(first.applied).toEqual(["0001_outbox_inbox.sql", "0002_seats.sql"]);
      const second = await runMigrations(pool, dir);
      expect(second.applied).toEqual([]);

      await writeFile(join(dir, "0002_seats.sql"), "create table seats (id bigint primary key);");
      await expect(runMigrations(pool, dir)).rejects.toBeInstanceOf(MigrationError);
      await writeFile(
        join(dir, "0002_seats.sql"),
        "create table seats (id int primary key, sold boolean not null default false);",
      );

      // Migraciones concurrentes (dos réplicas arrancando a la vez): el advisory lock las serializa.
      await writeFile(join(dir, "0003_more.sql"), "create table more_things (id int);");
      const results = await Promise.all([runMigrations(pool, dir), runMigrations(pool, dir)]);
      expect(results.flatMap((result) => result.applied)).toEqual(["0003_more.sql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("la transacción hace rollback completo si falla", async () => {
    await pool.query("insert into seats (id) values (1), (2)");
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("update seats set sold = true where id = 1");
        throw new Error("fallo a mitad de camino");
      }),
    ).rejects.toThrow("fallo a mitad de camino");
    const { rows } = await pool.query("select sold from seats where id = 1");
    expect(rows[0].sold).toBe(false);
  });

  it("FOR UPDATE evita la doble venta bajo concurrencia", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        withTransaction(pool, async (client) => {
          const { rows } = await client.query("select sold from seats where id = 2 for update");
          if (rows[0].sold) throw new Error("vendida");
          await client.query("update seats set sold = true where id = 2");
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  });

  it("outbox: publica en orden, reintenta los fallidos y no publica lo que hizo rollback", async () => {
    const committed = createEvent({
      type: "PruebaHecha",
      source: "commons",
      aggregateId: "a1",
      data: { n: 1 },
    });
    const second = createEvent({
      type: "PruebaHecha",
      source: "commons",
      aggregateId: "a1",
      data: { n: 2 },
    });
    const rolledBack = createEvent({
      type: "PruebaHecha",
      source: "commons",
      aggregateId: "a2",
      data: { n: 3 },
    });

    await withTransaction(pool, async (client) => {
      await enqueueOutbox(client, committed);
      await enqueueOutbox(client, second);
    });
    await expect(
      withTransaction(pool, async (client) => {
        await enqueueOutbox(client, rolledBack);
        throw new Error("rollback");
      }),
    ).rejects.toThrow();

    const published: EventEnvelope[] = [];
    let failNext = true;
    const relay = new OutboxRelay({
      pool,
      logger,
      publisher: {
        publish: async (event) => {
          if (failNext) {
            failNext = false;
            throw new Error("broker caído");
          }
          published.push(event);
        },
      },
    });
    expect(await relay.publishBatch()).toBe(0);
    expect(await relay.publishBatch()).toBe(2);
    expect(await relay.publishBatch()).toBe(0);
    expect(published.map((event) => event.data)).toEqual([{ n: 1 }, { n: 2 }]);
    const { rows } = await pool.query("select attempts from outbox where id = $1", [committed.id]);
    expect(rows[0].attempts).toBe(2);
  });

  it("inbox: un evento repetido no se procesa dos veces", async () => {
    const eventId = newId();
    expect(await markProcessed(pool, "tickets", eventId)).toBe(true);
    expect(await markProcessed(pool, "tickets", eventId)).toBe(false);
    expect(await markProcessed(pool, "notifications", eventId)).toBe(true);
  });

  it("bigint de Postgres llega como BigInt (montos CLP)", async () => {
    const { rows } = await pool.query("select 9007199254740993::bigint as amount");
    expect(rows[0].amount).toBe(9007199254740993n);
  });
});

describe.skipIf(!REDIS_URL)("redis", () => {
  let redis: Redis;

  beforeAll(() => {
    redis = createRedis({ url: REDIS_URL!, connectionName: "commons-test" });
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it("un solo proceso obtiene el lock y solo el dueño lo libera", async () => {
    const key = `test:lock:${newId()}`;
    const first = await acquireLock(redis, key, 5_000);
    expect(first).toBeDefined();
    expect(await acquireLock(redis, key, 5_000)).toBeUndefined();

    await redis.set(key, "otro-dueño", "PX", 5_000);
    expect(await first!.release()).toBe(false);
    expect(await redis.get(key)).toBe("otro-dueño");
    await redis.del(key);

    const runs = await Promise.all(
      Array.from({ length: 10 }, () => withLock(redis, key, 5_000, async () => "corrió")),
    );
    expect(runs.filter((run) => run === "corrió").length).toBeGreaterThanOrEqual(1);
    expect(await redis.exists(key)).toBe(0);
  });
});

describe.skipIf(!AMQP_URL)("rabbitmq", () => {
  let bus: RabbitEventBus;
  const suffix = newId().slice(0, 8);

  beforeAll(async () => {
    bus = await RabbitEventBus.connect({ url: AMQP_URL!, logger, connectionName: "commons-test" });
  });

  afterAll(async () => {
    await bus?.close();
  });

  it("publica con confirmación y entrega al consumidor suscrito", async () => {
    const received = new Promise<EventEnvelope>((resolve) => {
      void bus.subscribe({
        queue: `commons-test.ok.${suffix}`,
        bindings: [`commons.PruebaOk${suffix.replace(/\d/g, "X")}.*`],
        handler: async (event) => resolve(event),
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const event = createEvent({
      type: `PruebaOk${suffix.replace(/\d/g, "X")}`,
      source: "commons",
      aggregateId: "a1",
      data: { ok: true },
    });
    await bus.publish(event);
    expect(await received).toEqual(event);
  });

  it("reintenta un handler que falla y, al agotar los intentos, lo deja en la DLQ", async () => {
    const type = `PruebaFalla${suffix.replace(/\d/g, "X")}`;
    const queue = `commons-test.fail.${suffix}`;
    let calls = 0;
    await bus.subscribe({
      queue,
      bindings: [`commons.${type}.*`],
      maxDeliveries: 2,
      handler: async () => {
        calls++;
        throw new Error("siempre falla");
      },
    });
    await bus.publish(createEvent({ type, source: "commons", aggregateId: "a1", data: {} }));

    const { connect } = await import("amqplib");
    const connection = await connect(AMQP_URL!);
    const channel = await connection.createChannel();
    let deadLettered = false;
    for (let i = 0; i < 100 && !deadLettered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      deadLettered = (await channel.checkQueue(`${queue}.dlq`)).messageCount === 1;
    }
    await connection.close();
    expect(deadLettered).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
