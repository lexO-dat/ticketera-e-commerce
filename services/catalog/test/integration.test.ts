/**
 * Flujos completos contra Postgres real (y Redis si está TEST_REDIS_URL). Se activa con
 * TEST_DATABASE_URL (ver README). Cada corrida usa un esquema y un prefijo de caché propios.
 */
import { fileURLToPath } from "node:url";
import { createLogger, newId } from "@shared/commons";
import { createTokenVerifier, localKeySet } from "@shared/commons/auth";
import { type Pool, createPool, runMigrations } from "@shared/commons/db";
import { createRedis } from "@shared/commons/redis";
import type { FastifyInstance } from "fastify";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { type ReadCache, createReadCache, noCache } from "../src/cache.js";
import { type MetricsService, createMetricsService } from "../src/metrics/service.js";
import { seedDemoData } from "../src/seed.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const logger = createLogger({ service: "catalog-test", level: "silent" });

const ARENA = "11111111-1111-1111-1111-111111111111";
const TEATRO = "22222222-2222-2222-2222-222222222222";
const PLATEA_TEATRO = "a2000000-0000-0000-0000-000000000001";
const CANCHA_ARENA = "a1000000-0000-0000-0000-000000000001";
const LUMEN_DATE = "d0000000-0000-0000-0000-000000000001";

describe.skipIf(!DATABASE_URL)("catalog (integración)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let redis: ReturnType<typeof createRedis> | undefined;
  let metrics: MetricsService;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  const schema = `catalog_${newId().replaceAll("-", "").slice(0, 12)}`;
  const users = {
    admin: { id: newId(), roles: ["admin"] },
    organizerA: { id: newId(), roles: ["organizer"] },
    organizerB: { id: newId(), roles: ["organizer"] },
    seller: { id: newId(), roles: ["seller"] },
    customer: { id: newId(), roles: ["customer"] },
  };
  type UserName = keyof typeof users;
  const tokens = {} as Record<UserName, string>;

  async function sign(user: { id: string; roles: string[] }) {
    return new SignJWT({ roles: user.roles, email_verified: true, sid: newId() })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1", typ: "at+jwt" })
      .setIssuer("ticketera-identity")
      .setAudience("ticketera")
      .setSubject(user.id)
      .setJti(newId())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    as?: UserName,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: as ? { authorization: `Bearer ${tokens[as]}` } : {},
    });

  async function outbox(type: string, aggregateId: string) {
    const { rows } = await pool.query<{ payload: { data: Record<string, unknown> } }>(
      "select payload from outbox where type = $1 and aggregate_id = $2 order by seq",
      [type, aggregateId],
    );
    return rows.map((row) => row.payload.data);
  }

  const eventInput = (title: string, overrides: object = {}) => ({
    title,
    artist: "Banda",
    category: "conciertos",
    description: null,
    imageId: null,
    status: "published",
    featured: false,
    urgencyNote: null,
    ageRestriction: "TE",
    ...overrides,
  });

  const dateInput = (overrides: object = {}) => ({
    venueId: TEATRO,
    startsAt: "2030-03-01T23:00:00Z",
    doorsAt: "2030-03-01T22:00:00Z",
    onSale: true,
    ticketTypes: [
      { sectionId: PLATEA_TEATRO, name: "Platea", price: 50000, fee: "5000", capacity: 100 },
    ],
    ...overrides,
  });

  function multipart(field: string, filename: string, content: Buffer) {
    const boundary = `----catalog${newId()}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
          "Content-Type: image/jpeg\r\n\r\n",
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  beforeAll(async () => {
    const admin = createPool({ connectionString: DATABASE_URL!, applicationName: "catalog-test" });
    await admin.query(`create schema ${schema}`);
    await admin.end();
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ connectionString: url.toString(), applicationName: "catalog-test" });
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    const seedFile = fileURLToPath(new URL("../seed/demo.sql", import.meta.url));
    expect(await seedDemoData(pool, seedFile, logger)).toBe(true);
    // Idempotente: una segunda réplica que arranca no vuelve a cargarlo.
    expect(await seedDemoData(pool, seedFile, logger)).toBe(false);

    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    privateKey = pair.privateKey;
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }] };
    for (const name of Object.keys(users) as UserName[]) tokens[name] = await sign(users[name]);

    let cache: ReadCache = noCache;
    if (REDIS_URL) {
      redis = createRedis({ url: REDIS_URL, connectionName: "catalog-test", logger });
      cache = createReadCache({ redis, ttlSeconds: 30, logger, prefix: `${schema}:` });
    }
    metrics = createMetricsService({ pool, redis, keyPrefix: `${schema}:metrics` });
    app = buildApp({
      logger,
      pool,
      cache,
      metrics,
      verifyToken: createTokenVerifier({ getKey: localKeySet(jwks) }),
      mediaPublicPath: "/api/catalog/media",
      mediaMaxUploadBytes: 2 * 1024 * 1024,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (redis) {
      const keys = await redis.keys(`${schema}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
    await pool?.query(`drop schema if exists ${schema} cascade`);
    await pool?.end();
  });

  it("migra los datos semilla del prototipo conservando sus identificadores", async () => {
    const list = await request("GET", "/v1/events");
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toContain("public");
    const body = list.json() as { events: { slug: string; minPrice: string }[]; cities: string[] };
    expect(body.events).toHaveLength(8);
    expect(body.cities).toEqual(["Santiago", "Valparaíso"]);

    const lumen = (await request("GET", "/v1/events/lumen-tour-santiago")).json();
    expect(lumen.id).toBe("e0000000-0000-0000-0000-000000000001");
    expect(lumen.dates).toHaveLength(2);
    expect(lumen.dates[0].ticketTypes.map((t: { price: string }) => t.price)).toEqual([
      "145000",
      "62000",
      "89000",
      "89000",
      "54000",
    ]);

    const map = (await request("GET", `/v1/dates/${LUMEN_DATE}/seat-map`)).json();
    expect(map.date.venue.id).toBe(ARENA);
    expect(map.sections).toHaveLength(5);
    const seated = map.sections.filter((s: { kind: string }) => s.kind === "seated");
    // La capacidad de un sector numerado es su número de butacas.
    for (const section of seated) {
      const seats = map.seats.filter(
        (seat: { sectionId: string }) => seat.sectionId === section.id,
      );
      expect(seats.length).toBe(section.capacity);
    }
    expect(map.seats.filter((seat: { blocked: boolean }) => seat.blocked)).toHaveLength(4);

    const products = (await request("GET", "/v1/products")).json();
    expect(products.items).toHaveLength(3);
  });

  it("no expone borradores ni datos internos al público", async () => {
    const created = await request(
      "POST",
      "/v1/admin/events",
      "admin",
      eventInput("Borrador secreto", { status: "draft" }),
    );
    expect(created.statusCode).toBe(201);
    const { slug, id } = created.json();
    expect((await request("GET", `/v1/events/${slug}`)).statusCode).toBe(404);
    const list = (await request("GET", "/v1/events?q=secreto")).json();
    expect(list.events).toHaveLength(0);

    const published = (await request("GET", "/v1/events/lumen-tour-santiago")).json();
    expect(published).not.toHaveProperty("ownerId");
    expect(published).not.toHaveProperty("imageId");
    await request("DELETE", `/v1/admin/events/${id}`, "admin");
  });

  it("autoriza por rol y por dueño (reemplaza RLS)", async () => {
    expect((await request("GET", "/v1/admin/events")).statusCode).toBe(401);
    expect((await request("GET", "/v1/admin/events", "customer")).statusCode).toBe(403);
    expect((await request("POST", "/v1/admin/events", "seller", eventInput("X"))).statusCode).toBe(
      403,
    );

    const created = await request(
      "POST",
      "/v1/admin/events",
      "organizerA",
      eventInput("Show de A"),
    );
    expect(created.statusCode).toBe(201);
    const event = created.json();
    expect(event.ownerId).toBe(users.organizerA.id);

    const mine = (await request("GET", "/v1/admin/events", "organizerA")).json();
    expect(mine.items.map((e: { id: string }) => e.id)).toEqual([event.id]);
    expect((await request("GET", "/v1/admin/events", "organizerB")).json().items).toHaveLength(0);

    // B no ve ni toca el evento de A (404: no se revela que existe).
    expect((await request("GET", `/v1/admin/events/${event.id}`, "organizerB")).statusCode).toBe(
      404,
    );
    expect(
      (await request("PUT", `/v1/admin/events/${event.id}`, "organizerB", eventInput("Robado")))
        .statusCode,
    ).toBe(404);
    expect((await request("DELETE", `/v1/admin/events/${event.id}`, "organizerB")).statusCode).toBe(
      404,
    );
    expect(
      (await request("POST", `/v1/admin/events/${event.id}/dates`, "organizerB", dateInput()))
        .statusCode,
    ).toBe(404);
    // Tampoco los eventos de la plataforma (sin dueño).
    expect(
      (
        await request(
          "PUT",
          "/v1/admin/events/e0000000-0000-0000-0000-000000000001",
          "organizerA",
          eventInput("Y"),
        )
      ).statusCode,
    ).toBe(404);

    // Los recintos solo los modifica admin; los organizadores los ven para programar.
    expect((await request("GET", "/v1/admin/venues", "organizerA")).statusCode).toBe(200);
    expect(
      (
        await request("POST", "/v1/admin/venues", "organizerA", {
          name: "X",
          city: "Y",
          capacity: 1,
        })
      ).statusCode,
    ).toBe(403);

    // El admin administra todo.
    const updated = await request(
      "PUT",
      `/v1/admin/events/${event.id}`,
      "admin",
      eventInput("Show de A (editado)"),
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.json().ownerId).toBe(users.organizerA.id);
    expect((await request("DELETE", `/v1/admin/events/${event.id}`, "organizerA")).statusCode).toBe(
      204,
    );
  });

  it("valida fechas y tipos de entrada contra el recinto", async () => {
    const event = (
      await request("POST", "/v1/admin/events", "admin", eventInput("Validaciones"))
    ).json();
    const base = `/v1/admin/events/${event.id}/dates`;

    const otherVenue = await request(
      "POST",
      base,
      "admin",
      dateInput({
        ticketTypes: [{ sectionId: CANCHA_ARENA, name: "X", price: 1, fee: 0, capacity: 1 }],
      }),
    );
    expect(otherVenue.statusCode).toBe(400);
    expect(otherVenue.json().issues[0].path).toBe("ticketTypes.0.sectionId");

    const tooMany = await request(
      "POST",
      base,
      "admin",
      dateInput({
        ticketTypes: [{ sectionId: PLATEA_TEATRO, name: "X", price: 1, fee: 0, capacity: 100000 }],
      }),
    );
    expect(tooMany.statusCode).toBe(400);

    const doorsAfter = await request(
      "POST",
      base,
      "admin",
      dateInput({ doorsAt: "2030-03-02T00:00:00Z" }),
    );
    expect(doorsAfter.statusCode).toBe(400);

    const negative = await request(
      "POST",
      base,
      "admin",
      dateInput({
        ticketTypes: [{ sectionId: PLATEA_TEATRO, name: "X", price: -5, fee: 0, capacity: 1 }],
      }),
    );
    expect(negative.statusCode).toBe(400);

    const ok = await request("POST", base, "admin", dateInput());
    expect(ok.statusCode).toBe(201);
    const date = ok.json().dates[0];
    expect(date.ticketTypes[0]).toMatchObject({ price: "50000", fee: "5000", capacity: 100 });

    // Actualizar la fecha hace upsert por sector (mismo id de tipo de entrada).
    const edited = await request(
      "PUT",
      `/v1/admin/dates/${date.id}`,
      "admin",
      dateInput({
        ticketTypes: [
          { sectionId: PLATEA_TEATRO, name: "Platea", price: 55000, fee: 5500, capacity: 120 },
        ],
      }),
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json().dates[0].ticketTypes[0]).toMatchObject({
      id: date.ticketTypes[0].id,
      price: "55000",
    });

    // No se cambia el recinto de una fecha que ya tiene entradas.
    const moved = await request(
      "PUT",
      `/v1/admin/dates/${date.id}`,
      "admin",
      dateInput({ venueId: ARENA, ticketTypes: [] }),
    );
    expect(moved.statusCode).toBe(409);
    expect(moved.json().reason).toBe("DATE_HAS_TICKET_TYPES");

    // Un sector con entradas no se borra ni regenera sus butacas; el recinto en uso tampoco.
    const section = await request("DELETE", `/v1/admin/sections/${PLATEA_TEATRO}`, "admin");
    expect(section.statusCode).toBe(409);
    const regen = await request("PUT", `/v1/admin/sections/${PLATEA_TEATRO}`, "admin", {
      name: "Platea",
      kind: "seated",
      capacity: 10,
      sortOrder: 1,
      shape: { x: 200, y: 240, w: 600, h: 200 },
      seatGrid: { rows: 2, perRow: 5 },
    });
    expect(regen.statusCode).toBe(409);
    expect((await request("DELETE", `/v1/admin/venues/${TEATRO}`, "admin")).statusCode).toBe(409);

    await request("DELETE", `/v1/admin/events/${event.id}`, "admin");
  });

  it("crea recintos, sectores y butacas, y bloquea butacas", async () => {
    const venue = await request("POST", "/v1/admin/venues", "admin", {
      name: "Sala Nueva",
      city: "Concepción",
      address: null,
      capacity: 200,
    });
    expect(venue.statusCode).toBe(201);
    const section = await request("POST", `/v1/admin/venues/${venue.json().id}/sections`, "admin", {
      name: "Platea",
      kind: "seated",
      capacity: 0,
      sortOrder: 0,
      shape: { x: 100, y: 100, w: 300, h: 120 },
      seatGrid: { rows: 4, perRow: 10 },
    });
    expect(section.statusCode).toBe(201);
    expect(section.json().capacity).toBe(40);
    const seats = (
      await request("GET", `/v1/admin/sections/${section.json().id}/seats`, "admin")
    ).json();
    expect(seats.items).toHaveLength(40);
    expect(
      (await request("PUT", `/v1/admin/seats/${seats.items[0].id}`, "admin", { blocked: true }))
        .statusCode,
    ).toBe(204);
    const after = (
      await request("GET", `/v1/admin/sections/${section.json().id}/seats`, "admin")
    ).json();
    expect(after.items.filter((s: { blocked: boolean }) => s.blocked)).toHaveLength(1);
    // Editar un sector numerado sin regenerar conserva sus butacas: la capacidad la fija el servidor.
    const renamed = await request("PUT", `/v1/admin/sections/${section.json().id}`, "admin", {
      name: "Platea Central",
      kind: "seated",
      capacity: 0,
      sortOrder: 0,
      shape: { x: 100, y: 100, w: 300, h: 120 },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Platea Central", capacity: 40 });
    expect(
      (await request("DELETE", `/v1/admin/venues/${venue.json().id}`, "admin")).statusCode,
    ).toBe(204);
  });

  it("invalida la caché pública al escribir y publica el estado completo por outbox", async () => {
    const before = (await request("GET", "/v1/events?q=ruido")).json();
    expect(before.events[0].title).toBe("Ruido Blanco");
    const id = "e0000000-0000-0000-0000-000000000007";
    const event = (await request("GET", `/v1/admin/events/${id}`, "admin")).json();

    const updated = await request("PUT", `/v1/admin/events/${id}`, "admin", {
      ...eventInput("Ruido Blanco — Gira Final"),
      category: event.category,
    });
    expect(updated.statusCode).toBe(200);
    const after = (await request("GET", "/v1/events?q=ruido")).json();
    expect(after.events[0].title).toBe("Ruido Blanco — Gira Final");
    const detail = (await request("GET", "/v1/events/ruido-blanco")).json();
    expect(detail.title).toBe("Ruido Blanco — Gira Final");

    const published = await outbox("EventoActualizado", id);
    expect(published.at(-1)).toMatchObject({
      eventId: id,
      title: "Ruido Blanco — Gira Final",
      status: "published",
    });
    const dates = published.at(-1)!.dates as {
      ticketTypes: { capacity: number; price: string }[];
    }[];
    expect(dates[0]!.ticketTypes.length).toBeGreaterThan(0);
    expect(typeof dates[0]!.ticketTypes[0]!.price).toBe("string");
  });

  it("configura la fila virtual del evento y la publica (por id para otros servicios)", async () => {
    const lumenId = "e0000000-0000-0000-0000-000000000001";
    const seeded = (await request("GET", `/v1/events/by-id/${lumenId}`)).json();
    expect(seeded.queue).toMatchObject({ enabled: true, concurrentSlots: 250, windowMinutes: 10 });

    const event = (
      await request("POST", "/v1/admin/events", "organizerA", eventInput("Con fila"))
    ).json();
    expect(event.queue.enabled).toBe(false);
    const queue = {
      enabled: true,
      opensAt: "2030-01-01T12:00:00Z",
      concurrentSlots: 50,
      windowMinutes: 8,
      admitBatchMax: 10,
      waitingMessage: "Espera tu turno",
    };
    expect(
      (await request("PUT", `/v1/admin/events/${event.id}/queue`, "organizerB", queue)).statusCode,
    ).toBe(404);
    expect(
      (
        await request("PUT", `/v1/admin/events/${event.id}/queue`, "organizerA", {
          ...queue,
          concurrentSlots: 0,
        })
      ).statusCode,
    ).toBe(400);
    const updated = await request("PUT", `/v1/admin/events/${event.id}/queue`, "organizerA", queue);
    expect(updated.statusCode).toBe(200);
    expect(updated.json().queue).toEqual({ ...queue, opensAt: "2030-01-01T12:00:00.000Z" });

    const byId = (await request("GET", `/v1/events/by-id/${event.id}`)).json();
    expect(byId.queue.concurrentSlots).toBe(50);
    expect(byId).not.toHaveProperty("ownerId");
    expect((await outbox("EventoActualizado", event.id)).at(-1)!.queue).toMatchObject({
      enabled: true,
      windowMinutes: 8,
    });
    await request("DELETE", `/v1/admin/events/${event.id}`, "organizerA");
    expect((await request("GET", `/v1/events/by-id/${event.id}`)).statusCode).toBe(404);
  });

  it("slugs únicos aun con creaciones concurrentes del mismo título", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request("POST", "/v1/admin/events", "admin", eventInput("Mismo Título")),
      ),
    );
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    const slugs = new Set(responses.map((response) => response.json().slug));
    expect(slugs.size).toBe(10);
    for (const response of responses) {
      await request("DELETE", `/v1/admin/events/${response.json().id}`, "admin");
      expect(await outbox("EventoEliminado", response.json().id)).toHaveLength(1);
    }
  });

  it("productos: dueño vendedor, SKU único y solo activos en público", async () => {
    const product = {
      name: "Polera Test",
      description: null,
      sku: "TEST-001",
      price: 19990,
      imageId: null,
      eventId: "e0000000-0000-0000-0000-000000000001",
      status: "active",
      maxPerOrder: 3,
    };
    const created = await request("POST", "/v1/admin/products", "seller", product);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ownerId: users.seller.id, price: "19990", fee: "0" });

    const duplicate = await request("POST", "/v1/admin/products", "admin", {
      ...product,
      name: "Otra",
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().reason).toBe("SKU_TAKEN");

    expect((await request("POST", "/v1/admin/products", "organizerA", product)).statusCode).toBe(
      403,
    );
    expect((await request("GET", "/v1/admin/products", "seller")).json().items).toHaveLength(1);

    const id = created.json().id;
    const draft = await request("PUT", `/v1/admin/products/${id}`, "seller", {
      ...product,
      status: "draft",
    });
    expect(draft.statusCode).toBe(200);
    const visible = (await request("GET", "/v1/products"))
      .json()
      .items.map((p: { id: string }) => p.id);
    expect(visible).not.toContain(id);
    expect((await outbox("ProductoActualizado", id)).map((data) => data.status)).toEqual([
      "active",
      "draft",
    ]);
  });

  it("ItemVendible: precios del servidor y motivo cuando no se puede vender", async () => {
    const event = (
      await request(
        "POST",
        "/v1/admin/events",
        "admin",
        eventInput("Para resolver", { status: "draft" }),
      )
    ).json();
    const withDate = (
      await request("POST", `/v1/admin/events/${event.id}/dates`, "admin", dateInput())
    ).json();
    const draftTicket = withDate.dates[0].ticketTypes[0].id;
    const lumen = (await request("GET", "/v1/events/lumen-tour-santiago")).json();
    const lumenTicket = lumen.dates[0].ticketTypes[0];

    const response = await request("POST", "/v1/items/resolve", undefined, {
      items: [
        { kind: "ticket_type", id: lumenTicket.id },
        { kind: "ticket_type", id: draftTicket },
        { kind: "product", id: "b0000000-0000-0000-0000-000000000002" },
        { kind: "nave_espacial", id: newId() },
        { kind: "product", id: newId() },
      ],
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.kinds).toEqual(["ticket_type", "product"]);
    const byId = new Map(body.items.map((item: { id: string }) => [item.id, item]));
    expect(byId.size).toBe(3);
    expect(byId.get(lumenTicket.id)).toMatchObject({
      kind: "ticket_type",
      unitPrice: lumenTicket.price,
      unitFee: lumenTicket.fee,
      saleable: true,
      attributes: { eventDateId: LUMEN_DATE, seated: true },
    });
    expect(byId.get(draftTicket)).toMatchObject({
      saleable: false,
      unsaleableReason: "EVENT_NOT_PUBLISHED",
    });
    expect(byId.get("b0000000-0000-0000-0000-000000000002")).toMatchObject({
      kind: "product",
      unitPrice: "32990",
    });
    await request("DELETE", `/v1/admin/events/${event.id}`, "admin");
  });

  it("media: sube, re-codifica, sirve con caché inmutable y se asocia a un evento", async () => {
    const jpeg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#123456" },
    })
      .jpeg()
      .toBuffer();
    const upload = (as: UserName | undefined, content: Buffer) => {
      const form = multipart("file", "foto.jpg", content);
      return app.inject({
        method: "POST",
        url: "/v1/admin/media",
        payload: form.body,
        headers: {
          "content-type": form.contentType,
          ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
        },
      });
    };

    expect((await upload(undefined, jpeg)).statusCode).toBe(401);
    expect((await upload("customer", jpeg)).statusCode).toBe(403);
    const fake = await upload("organizerA", Buffer.from("<?php system($_GET['c']); ?>"));
    expect(fake.statusCode).toBe(400);
    expect(fake.json().reason).toBe("INVALID_IMAGE");
    const huge = await upload("admin", Buffer.alloc(3 * 1024 * 1024, 1));
    expect(huge.statusCode).toBe(413);

    const stored = await upload("organizerA", jpeg);
    expect(stored.statusCode).toBe(201);
    const media = stored.json();
    expect(media).toMatchObject({ contentType: "image/webp", width: 800, height: 600 });
    // Mismo contenido → mismo registro.
    expect((await upload("admin", jpeg)).json().id).toBe(media.id);

    const image = await request("GET", `/v1/media/${media.id}`);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/webp");
    expect(image.headers["cache-control"]).toContain("immutable");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    const cached = await app.inject({
      url: `/v1/media/${media.id}`,
      headers: { "if-none-match": image.headers.etag as string },
    });
    expect(cached.statusCode).toBe(304);

    const event = await request(
      "POST",
      "/v1/admin/events",
      "organizerA",
      eventInput("Con imagen", { imageId: media.id }),
    );
    expect(event.json().imageUrl).toBe(`/api/catalog/media/${media.id}`);
    const missing = await request(
      "POST",
      "/v1/admin/events",
      "organizerA",
      eventInput("X", { imageId: newId() }),
    );
    expect(missing.statusCode).toBe(400);
    await request("DELETE", `/v1/admin/events/${event.json().id}`, "organizerA");
  });

  it("métricas del embudo: vistas en lote, eventos de dominio idempotentes y alcance por dueño", async () => {
    const LUMEN = "e0000000-0000-0000-0000-000000000001";
    for (let n = 0; n < 5; n++) {
      expect((await request("POST", `/v1/events/${LUMEN}/views`)).statusCode).toBe(202);
    }
    // Un id inexistente se acepta (endpoint público barato) y se descarta al volcar.
    await request("POST", `/v1/events/${newId()}/views`);
    expect((await request("POST", "/v1/events/no-uuid/views")).statusCode).toBe(400);
    await metrics.flushViews();

    const ticketType = await pool.query<{ id: string }>(
      "select id from ticket_types where event_date_id = $1 limit 1",
      [LUMEN_DATE],
    );
    const envelope = (type: string, data: Record<string, unknown>) => ({
      id: newId(),
      type,
      version: 1,
      source: "test",
      occurredAt: new Date().toISOString(),
      aggregateId: newId(),
      data,
    });
    const reservation = envelope("ReservaCreada", {
      reservationId: newId(),
      userId: newId(),
      itemId: ticketType.rows[0]!.id,
      quantity: 2,
      expiresAt: new Date().toISOString(),
    });
    await metrics.handleEvent(reservation);
    await metrics.handleEvent(reservation); // repetido: no se cuenta dos veces
    await metrics.handleEvent(
      envelope("OrdenCreada", { orderId: newId(), userId: newId(), total: "1", eventIds: [LUMEN] }),
    );
    await metrics.handleEvent(
      envelope("OrdenConfirmada", {
        orderId: newId(),
        userId: newId(),
        total: "250000",
        lines: [
          {
            lineId: newId(),
            kind: "ticket_type",
            itemId: newId(),
            name: "VIP",
            quantity: 2,
            unitPrice: "120000",
            unitFee: "5000",
            eventId: LUMEN,
            seatIds: [],
          },
          {
            lineId: newId(),
            kind: "product",
            itemId: newId(),
            name: "Polera",
            quantity: 1,
            unitPrice: "15000",
            unitFee: "0",
            eventId: null,
            seatIds: [],
          },
        ],
      }),
    );

    const summary = (await request("GET", "/v1/admin/metrics?days=7", "admin")).json();
    expect(summary.funnel).toEqual({ view: 5, add_to_cart: 2, checkout: 1, purchase: 2 });
    const lumen = summary.events.find((e: { eventId: string }) => e.eventId === LUMEN);
    expect(lumen).toMatchObject({
      views: 5,
      addToCart: 2,
      checkouts: 1,
      purchases: 2,
      revenue: "250000",
    });
    expect(summary.daily).toHaveLength(1);
    expect(summary.daily[0]).toMatchObject({ views: 5, purchases: 2, revenue: "250000" });

    // El organizador solo ve sus eventos (Lumen es de la plataforma); el cliente, nada.
    expect((await request("GET", "/v1/admin/metrics", "organizerB")).json().events).toEqual([]);
    expect((await request("GET", "/v1/admin/metrics", "customer")).statusCode).toBe(403);
  });

  it("newsletter: misma respuesta aunque ya esté suscrito; correo normalizado", async () => {
    const email = `Fan-${newId().slice(0, 8)}@Example.com`;
    expect((await request("POST", "/v1/newsletter", undefined, { email })).statusCode).toBe(202);
    expect((await request("POST", "/v1/newsletter", undefined, { email })).statusCode).toBe(202);
    expect(
      (await request("POST", "/v1/newsletter", undefined, { email: "no-es-correo" })).statusCode,
    ).toBe(400);
    const rows = await pool.query("select email from newsletter_subscribers where email = $1", [
      email.toLowerCase(),
    ]);
    expect(rows.rowCount).toBe(1);
  });
});
