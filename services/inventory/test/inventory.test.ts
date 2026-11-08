/**
 * Reservas contra Postgres y Redis reales (TEST_DATABASE_URL, TEST_REDIS_URL). Casos obligatorios
 * de concurrencia (AGENTS §8): sobreventa de butacas y de sectores generales, vencimiento y fila.
 */
import { fileURLToPath } from "node:url";
import { type EventEnvelope, createEvent, createLogger, newId } from "@shared/commons";
import {
  admissionJtiKey,
  createAdmissionVerifier,
  createTokenVerifier,
  localKeySet,
} from "@shared/commons/auth";
import { type Pool, createPool, runMigrations } from "@shared/commons/db";
import { type Redis, createRedis } from "@shared/commons/redis";
import type { FastifyInstance } from "fastify";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CatalogClient, CatalogEvent, CatalogSeat } from "../src/catalog-client.js";
import { handleCatalogEvent } from "../src/catalog-events.js";
import type { ReservationService } from "../src/reservations.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const logger = createLogger({ service: "inventory-test", level: "silent" });

type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

describe.skipIf(!DATABASE_URL || !REDIS_URL)("inventory (integración)", () => {
  let pool: Pool;
  let redis: Redis;
  let app: FastifyInstance;
  let reservations: ReservationService;
  let accessKey: Key;
  let admissionKey: Key;
  const schema = `inventory_${newId().replaceAll("-", "").slice(0, 12)}`;

  // Catálogo falso: un evento por prueba, con un sector numerado y uno general.
  const events = new Map<string, CatalogEvent>();
  const seatsByDate = new Map<string, Map<string, CatalogSeat>>();
  const catalog: CatalogClient = {
    eventById: async (id) => events.get(id) ?? null,
    eventIdForTicketType: async (ticketTypeId) =>
      [...events.values()].find((event) =>
        event.dates.some((date) => date.ticketTypes.some((type) => type.id === ticketTypeId)),
      )?.id ?? null,
    seats: async (dateId) => seatsByDate.get(dateId) ?? new Map(),
  };

  function makeEvent(options: { queue?: boolean; generalCapacity?: number; seats?: number } = {}) {
    const eventId = newId();
    const dateId = newId();
    const seatedSection = newId();
    const generalSection = newId();
    const seated = newId();
    const general = newId();
    const seats = Array.from({ length: options.seats ?? 20 }, () => newId());
    const blocked = newId();
    seatsByDate.set(
      dateId,
      new Map<string, CatalogSeat>([
        ...seats.map((id): [string, CatalogSeat] => [
          id,
          { id, sectionId: seatedSection, blocked: false },
        ]),
        [blocked, { id: blocked, sectionId: seatedSection, blocked: true }],
      ]),
    );
    events.set(eventId, {
      id: eventId,
      status: "published",
      queue: { enabled: options.queue ?? false },
      dates: [
        {
          id: dateId,
          startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          onSale: true,
          ticketTypes: [
            { id: seated, sectionId: seatedSection, sectionKind: "seated", capacity: seats.length },
            {
              id: general,
              sectionId: generalSection,
              sectionKind: "general",
              capacity: options.generalCapacity ?? 50,
            },
          ],
        },
      ],
    });
    return { eventId, dateId, seated, general, seats, blocked, generalSection };
  }

  const tokens = new Map<string, string>();
  async function token(userId: string, roles = ["customer"]) {
    const key = `${userId}:${roles.join()}`;
    if (!tokens.has(key)) {
      tokens.set(
        key,
        await new SignJWT({ roles, email_verified: true })
          .setProtectedHeader({ alg: "EdDSA", kid: "a1" })
          .setIssuer("ticketera-identity")
          .setAudience("ticketera")
          .setSubject(userId)
          .setIssuedAt()
          .setExpirationTime("10m")
          .sign(accessKey),
      );
    }
    return tokens.get(key)!;
  }

  async function admissionFor(userId: string, eventId: string, store = true) {
    const jti = newId();
    if (store) await redis.set(admissionJtiKey(eventId, jti), userId, "EX", 600);
    const signed = await new SignJWT({ evt: eventId })
      .setProtectedHeader({ alg: "EdDSA", kid: "q1", typ: "admission+jwt" })
      .setIssuer("ticketera-queue")
      .setAudience("ticketera")
      .setSubject(userId)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(admissionKey);
    return { token: signed, jti };
  }

  async function reserve(userId: string, body: object, admission?: string) {
    return app.inject({
      method: "POST",
      url: "/v1/reservations",
      payload: body,
      headers: {
        authorization: `Bearer ${await token(userId)}`,
        ...(admission ? { "x-admission-token": admission } : {}),
      },
    });
  }

  async function audit(eventId: string) {
    return (
      await app.inject({
        url: `/v1/admin/audit/events/${eventId}`,
        headers: { authorization: `Bearer ${await token(newId(), ["admin"])}` },
      })
    ).json();
  }

  beforeAll(async () => {
    const admin = createPool({
      connectionString: DATABASE_URL!,
      applicationName: "inventory-test",
    });
    await admin.query(`create schema ${schema}`);
    await admin.end();
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({
      connectionString: url.toString(),
      applicationName: "inventory-test",
      max: 30,
    });
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    redis = createRedis({ url: REDIS_URL!, connectionName: "inventory-test", logger });

    const access = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const queue = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    accessKey = access.privateKey;
    admissionKey = queue.privateKey;
    const accessJwks = {
      keys: [{ ...(await exportJWK(access.publicKey)), kid: "a1", alg: "EdDSA" }],
    };
    const queueJwks = {
      keys: [{ ...(await exportJWK(queue.publicKey)), kid: "q1", alg: "EdDSA" }],
    };

    ({ app, reservations } = buildApp({
      logger,
      pool,
      redis,
      catalog,
      verifyToken: createTokenVerifier({ getKey: localKeySet(accessJwks) }),
      verifyAdmission: createAdmissionVerifier({ getKey: localKeySet(queueJwks) }),
      availabilityCacheMs: 0,
      cachePrefix: `${schema}:`,
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await pool?.query(`drop schema if exists ${schema} cascade`);
    await pool?.end();
  });

  it("100 compradores por la misma butaca: exactamente una reserva", async () => {
    const { eventId, seated, seats } = makeEvent();
    const target = seats[0]!;
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        reserve(newId(), { ticketTypeId: seated, seatIds: [target] }),
      ),
    );
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(99);
    expect(responses.find((r) => r.statusCode === 409)!.json().reason).toBe("SEAT_TAKEN");
    const result = await audit(eventId);
    expect(result.ok).toBe(true);
    expect(
      result.ticketTypes.find((t: { ticketTypeId: string }) => t.ticketTypeId === seated).reserved,
    ).toBe(1);
  });

  it("sector general: 200 compras simultáneas nunca superan la capacidad", async () => {
    const { eventId, general } = makeEvent({ generalCapacity: 50 });
    const responses = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        reserve(newId(), { ticketTypeId: general, quantity: (i % 3) + 1 }),
      ),
    );
    const reserved = responses
      .filter((r) => r.statusCode === 201)
      .reduce((sum, r) => sum + (r.json().quantity as number), 0);
    expect(reserved).toBeLessThanOrEqual(50);
    expect(reserved).toBeGreaterThanOrEqual(48); // se llena salvo un remanente menor que la última compra
    expect(
      responses
        .filter((r) => r.statusCode === 409)
        .every((r) => r.json().reason === "NOT_ENOUGH_AVAILABLE"),
    ).toBe(true);
    const result = await audit(eventId);
    expect(result.ok).toBe(true);
  });

  it("butacas con pedidos solapados: nadie queda con una butaca de otro", async () => {
    const { eventId, seated, seats } = makeEvent({ seats: 10 });
    // 60 compradores piden pares de butacas que se solapan.
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        reserve(newId(), { ticketTypeId: seated, seatIds: [seats[i % 10]!, seats[(i + 1) % 10]!] }),
      ),
    );
    const won = responses
      .filter((r) => r.statusCode === 201)
      .flatMap((r) => r.json().seatIds as string[]);
    expect(new Set(won).size).toBe(won.length);
    expect((await audit(eventId)).ok).toBe(true);
  });

  it("valida butacas y cantidades contra el tipo de entrada", async () => {
    const { seated, general, blocked } = makeEvent();
    const user = newId();
    expect((await reserve(user, { ticketTypeId: seated, seatIds: [blocked] })).statusCode).toBe(
      400,
    );
    expect((await reserve(user, { ticketTypeId: seated, seatIds: [newId()] })).statusCode).toBe(
      400,
    );
    expect((await reserve(user, { ticketTypeId: seated, quantity: 2 })).statusCode).toBe(400);
    expect((await reserve(user, { ticketTypeId: general, seatIds: [newId()] })).statusCode).toBe(
      400,
    );
    expect((await reserve(user, { ticketTypeId: newId(), quantity: 1 })).statusCode).toBe(404);
  });

  it("máximo 8 entradas por usuario y función", async () => {
    const { general } = makeEvent();
    const user = newId();
    expect((await reserve(user, { ticketTypeId: general, quantity: 5 })).statusCode).toBe(201);
    const over = await reserve(user, { ticketTypeId: general, quantity: 4 });
    expect(over.statusCode).toBe(409);
    expect(over.json().reason).toBe("LIMIT_PER_USER");
    expect((await reserve(user, { ticketTypeId: general, quantity: 3 })).statusCode).toBe(201);
  });

  it("liberar devuelve el cupo al instante y solo el dueño puede hacerlo", async () => {
    const { eventId, dateId, seated, seats } = makeEvent();
    const [owner, other] = [newId(), newId()];
    const created = (await reserve(owner, { ticketTypeId: seated, seatIds: [seats[3]!] })).json();
    const foreign = await app.inject({
      method: "DELETE",
      url: `/v1/reservations/${created.id}`,
      headers: { authorization: `Bearer ${await token(other)}` },
    });
    expect(foreign.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          url: `/v1/reservations/${created.id}`,
          headers: { authorization: `Bearer ${await token(other)}` },
        })
      ).statusCode,
    ).toBe(404);

    const started = performance.now();
    const released = await app.inject({
      method: "DELETE",
      url: `/v1/reservations/${created.id}`,
      headers: { authorization: `Bearer ${await token(owner)}` },
    });
    expect(released.statusCode).toBe(204);
    expect(performance.now() - started).toBeLessThan(500);
    const seatsTaken = (await app.inject({ url: `/v1/availability/dates/${dateId}/seats` })).json();
    expect(seatsTaken.unavailableSeatIds).not.toContain(seats[3]);
    expect((await reserve(other, { ticketTypeId: seated, seatIds: [seats[3]!] })).statusCode).toBe(
      201,
    );
    const { rows } = await pool.query(
      "select payload from outbox where aggregate_id = $1 and type = 'ReservaLiberada'",
      [created.id],
    );
    expect(rows[0].payload.data).toEqual({ reservationId: created.id, reason: "USER" });
    expect((await audit(eventId)).ok).toBe(true);
  });

  it("una reserva vencida deja de contar al consultarla y el barrido la libera", async () => {
    const { eventId, seated, general, seats } = makeEvent({ generalCapacity: 2 });
    const first = newId();
    const seat = (await reserve(first, { ticketTypeId: seated, seatIds: [seats[0]!] })).json();
    const gen = (await reserve(first, { ticketTypeId: general, quantity: 2 })).json();
    expect((await reserve(newId(), { ticketTypeId: general, quantity: 1 })).statusCode).toBe(409);

    // Simula el paso de los 10 minutos.
    await pool.query(
      "update reservations set expires_at = now() - interval '1 second' where id = any($1::uuid[])",
      [[seat.id, gen.id]],
    );
    const availability = (await app.inject({ url: `/v1/availability/events/${eventId}` })).json();
    expect(
      availability.items.find((i: { ticketTypeId: string }) => i.ticketTypeId === general)
        .available,
    ).toBe(2);
    // Expiración perezosa: la siguiente reserva ya puede tomar el cupo y la butaca.
    expect((await reserve(newId(), { ticketTypeId: general, quantity: 2 })).statusCode).toBe(201);
    expect(
      (await reserve(newId(), { ticketTypeId: seated, seatIds: [seats[0]!] })).statusCode,
    ).toBe(201);
    const mine = await app.inject({
      url: "/v1/reservations",
      headers: { authorization: `Bearer ${await token(first)}` },
    });
    expect(mine.json().items).toHaveLength(0);
    expect((await audit(eventId)).ok).toBe(true);

    // El barrido libera las que nadie tocó.
    const lonely = makeEvent();
    const stale = (await reserve(newId(), { ticketTypeId: lonely.general, quantity: 1 })).json();
    await pool.query(
      "update reservations set expires_at = now() - interval '1 second' where id = $1",
      [stale.id],
    );
    expect(await reservations.sweep()).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query("select status from reservations where id = $1", [stale.id]);
    expect(rows[0].status).toBe("EXPIRED");
    expect((await audit(lonely.eventId)).ok).toBe(true);
  });

  it("con fila virtual exige un turno válido, propio, del evento y vigente", async () => {
    const { eventId, general } = makeEvent({ queue: true });
    const other = makeEvent({ queue: true });
    const user = newId();
    const body = { ticketTypeId: general, quantity: 1 };

    const none = await reserve(user, body);
    expect(none.statusCode).toBe(403);
    expect(none.json().reason).toBe("ADMISSION_REQUIRED");
    expect(
      (await reserve(user, body, (await admissionFor(newId(), eventId)).token)).statusCode,
    ).toBe(403);
    expect(
      (await reserve(user, body, (await admissionFor(user, other.eventId)).token)).statusCode,
    ).toBe(403);
    expect(
      (await reserve(user, body, (await admissionFor(user, eventId, false)).token)).statusCode,
    ).toBe(403);
    expect((await reserve(user, body, "no.es.token")).statusCode).toBe(403);

    const valid = await admissionFor(user, eventId);
    const ok = await reserve(user, body, valid.token);
    expect(ok.statusCode).toBe(201);
    // Revocado (ventana vencida o compra completada): ya no sirve.
    await redis.del(admissionJtiKey(eventId, valid.jti));
    expect((await reserve(user, body, valid.token)).statusCode).toBe(403);
  });

  it("aplica los cambios de catalog en orden y deja de vender lo eliminado", async () => {
    const { eventId, dateId, general, generalSection } = makeEvent({ generalCapacity: 5 });
    expect((await reserve(newId(), { ticketTypeId: general, quantity: 1 })).statusCode).toBe(201);

    const update = (capacity: number, occurredAt: string, status = "published"): EventEnvelope => ({
      ...createEvent({
        type: "EventoActualizado",
        source: "catalog",
        aggregateId: eventId,
        data: {
          eventId,
          status,
          queue: { enabled: false },
          dates: [
            {
              dateId,
              startsAt: new Date(Date.now() + 86_400_000).toISOString(),
              onSale: true,
              ticketTypes: [
                { ticketTypeId: general, sectionId: generalSection, seated: false, capacity },
              ],
            },
          ],
        },
      }),
      occurredAt,
    });
    const newer = update(20, new Date(Date.now() + 1000).toISOString());
    await handleCatalogEvent(pool, newer);
    await handleCatalogEvent(pool, newer); // duplicado: inbox
    await handleCatalogEvent(pool, update(1, new Date(Date.now() - 60_000).toISOString())); // viejo
    const availability = (await app.inject({ url: `/v1/availability/events/${eventId}` })).json();
    expect(availability.items).toHaveLength(1); // el numerado ya no viene: inactivo
    expect(availability.items[0]).toMatchObject({ capacity: 20, reserved: 1, available: 19 });

    await handleCatalogEvent(pool, {
      ...createEvent({
        type: "EventoEliminado",
        source: "catalog",
        aggregateId: eventId,
        data: { eventId },
      }),
      occurredAt: new Date(Date.now() + 2000).toISOString(),
    });
    const closed = await reserve(newId(), { ticketTypeId: general, quantity: 1 });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().reason).toBe("NOT_ON_SALE");
  });
});
