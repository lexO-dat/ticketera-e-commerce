/** Entradas contra Postgres real (TEST_DATABASE_URL): emisión, QR firmado y check-in atómico. */
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createEvent, createLogger, newId } from "@shared/commons";
import { createTokenVerifier, localKeySet } from "@shared/commons/auth";
import { type Pool, createPool, runMigrations } from "@shared/commons/db";
import type { FastifyInstance } from "fastify";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { handleOrderEvent } from "../src/order-events.js";
import { type TicketQr, createTicketQr } from "../src/qr.js";
import { type ConfirmedOrder, type TicketService, createTicketService } from "../src/service.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const logger = createLogger({ service: "tickets-test", level: "silent" });
const pem = () =>
  generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe.skipIf(!DATABASE_URL)("tickets (integración)", () => {
  let pool: Pool;
  let tickets: TicketService;
  let qr: TicketQr;
  let app: FastifyInstance;
  let accessKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  const schema = `tickets_${newId().replaceAll("-", "").slice(0, 12)}`;

  function order(overrides: Partial<ConfirmedOrder> = {}): ConfirmedOrder {
    const dateId = newId();
    const eventId = newId();
    return {
      orderId: newId(),
      orderCode: "TK-ABCD2345",
      userId: newId(),
      buyerName: "Ana Pérez",
      buyerEmail: "ana@acceptme.com",
      lines: [
        {
          lineId: newId(),
          kind: "ticket_type",
          itemId: newId(),
          name: "Lumen Tour 2026 — VIP Frontal",
          quantity: 2,
          eventId,
          eventDateId: dateId,
          seatIds: [newId(), newId()],
          attributes: {
            startsAt: "2030-12-10T00:00:00.000Z",
            venueName: "Arena Central",
            sectionName: "VIP Frontal",
          },
        },
        {
          lineId: newId(),
          kind: "ticket_type",
          itemId: newId(),
          name: "Lumen Tour 2026 — Cancha General",
          quantity: 3,
          eventId,
          eventDateId: dateId,
          seatIds: [],
        },
        {
          lineId: newId(),
          kind: "product",
          itemId: newId(),
          name: "Polera",
          quantity: 1,
          eventId: null,
          eventDateId: null,
          seatIds: [],
        },
      ],
      ...overrides,
    };
  }

  const token = (sub: string, roles: string[]) =>
    new SignJWT({ roles, email_verified: true })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer("ticketera-identity")
      .setAudience("ticketera")
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(accessKey);

  beforeAll(async () => {
    const admin = createPool({ connectionString: DATABASE_URL!, applicationName: "tickets-test" });
    await admin.query(`create schema ${schema}`);
    await admin.end();
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({
      connectionString: url.toString(),
      applicationName: "tickets-test",
      max: 25,
    });
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    qr = await createTicketQr(pem(), "t1");
    tickets = createTicketService({
      pool,
      qr,
      logger,
      seats: {
        labels: async (_date, ids) => new Map(ids.map((id, i) => [id, `Fila A · Butaca ${i + 1}`])),
      },
    });
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    accessKey = pair.privateKey;
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }] };
    app = buildApp({
      logger,
      tickets,
      qr,
      verifyToken: createTokenVerifier({ getKey: localKeySet(jwks) }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.query(`drop schema if exists ${schema} cascade`);
    await pool?.end();
  });

  it("emite una entrada por unidad, una sola vez aunque el evento llegue repetido", async () => {
    const o = order();
    const event = createEvent({
      type: "OrdenConfirmada",
      source: "orders",
      aggregateId: o.orderId,
      data: { ...o },
    });
    await handleOrderEvent(pool, tickets, event);
    await handleOrderEvent(pool, tickets, event);
    expect(await tickets.issue(o)).toEqual([]); // sin inbox también es idempotente
    const mine = await tickets.listMine(o.userId);
    expect(mine).toHaveLength(5);
    expect(mine.filter((t) => t.seatLabel)).toHaveLength(2);
    expect(mine[0]).toMatchObject({
      venueName: "Arena Central",
      status: "ISSUED",
      holderName: "Ana Pérez",
    });
    expect(new Set(mine.map((t) => t.code)).size).toBe(5);
    expect(mine.every((t) => /^[0-9A-Z]{12}$/.test(t.code) && t.qr)).toBe(true);
    const { rows } = await pool.query(
      "select payload from outbox where type = 'EntradasEmitidas' and aggregate_id = $1",
      [o.orderId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.data.ticketIds).toHaveLength(5);
  });

  it("check-in atómico: 20 escaneos simultáneos del mismo QR → exactamente uno aceptado", async () => {
    const o = order();
    await tickets.issue(o);
    const [ticket] = await tickets.listMine(o.userId);
    const staff = newId();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tickets.checkin(staff, {
          qr: ticket!.qr!,
          eventDateId: ticket!.eventDateId,
          gate: `P${i % 3}`,
        }),
      ),
    );
    expect(results.filter((r) => r.result === "ACCEPTED")).toHaveLength(1);
    expect(results.filter((r) => r.result === "ALREADY_USED")).toHaveLength(19);
    const { rows } = await pool.query(
      "select count(*)::int as n from checkins where ticket_id = $1",
      [ticket!.id],
    );
    expect(rows[0].n).toBe(20);
    const validated = await pool.query(
      "select count(*)::int as n from outbox where type = 'EntradaValidada' and aggregate_id = $1",
      [ticket!.id],
    );
    expect(validated.rows[0].n).toBe(1);
    expect(await tickets.stats(ticket!.eventDateId)).toMatchObject({ issued: 5, checkedIn: 1 });
  });

  it("rechaza QR falsificado, función equivocada y entradas anuladas; acepta el código manual", async () => {
    const o = order();
    await tickets.issue(o);
    const [first, second, third] = await tickets.listMine(o.userId);
    const staff = newId();

    const forged = await (
      await createTicketQr(pem(), "t1")
    ).sign({ id: first!.id, eventDateId: first!.eventDateId });
    expect(
      (await tickets.checkin(staff, { qr: forged, eventDateId: first!.eventDateId })).result,
    ).toBe("INVALID");
    expect(
      (await tickets.checkin(staff, { qr: "basura", eventDateId: first!.eventDateId })).result,
    ).toBe("INVALID");
    expect((await tickets.checkin(staff, { qr: first!.qr!, eventDateId: newId() })).result).toBe(
      "WRONG_EVENT",
    );

    const manual = await tickets.checkin(staff, {
      code: second!.code.toLowerCase(),
      eventDateId: second!.eventDateId,
    });
    expect(manual).toMatchObject({ result: "ACCEPTED", ticket: { id: second!.id } });

    // Orden reembolsada: las entradas que no se usaron se anulan.
    await handleOrderEvent(
      pool,
      tickets,
      createEvent({
        type: "OrdenCancelada",
        source: "orders",
        aggregateId: o.orderId,
        data: { orderId: o.orderId, reason: "REFUNDED" },
      }),
    );
    expect(
      (await tickets.checkin(staff, { qr: third!.qr!, eventDateId: third!.eventDateId })).result,
    ).toBe("VOIDED");
    const after = await tickets.listMine(o.userId);
    expect(after.find((t) => t.id === third!.id)).toMatchObject({ status: "VOIDED" });
    expect(after.find((t) => t.id === third!.id)!.qr).toBeUndefined();
    expect(after.find((t) => t.id === second!.id)!.status).toBe("CHECKED_IN");
  });

  it("HTTP: el comprador ve solo sus entradas; solo el personal valida", async () => {
    const o = order();
    await tickets.issue(o);
    const owner = { authorization: `Bearer ${await token(o.userId, ["customer"])}` };
    const mine = await app.inject({ url: `/v1/tickets?orderCode=${o.orderCode}`, headers: owner });
    expect(mine.statusCode).toBe(200);
    const list = mine.json().items as { id: string; qr: string; eventDateId: string }[];
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(
      (await app.inject({ url: `/v1/tickets/${list[0]!.id}`, headers: owner })).json(),
    ).not.toHaveProperty("userId");
    const stranger = { authorization: `Bearer ${await token(newId(), ["customer"])}` };
    expect(
      (await app.inject({ url: `/v1/tickets/${list[0]!.id}`, headers: stranger })).statusCode,
    ).toBe(404);

    const payload = { qr: list[0]!.qr, eventDateId: list[0]!.eventDateId, gate: "Norte" };
    expect(
      (await app.inject({ method: "POST", url: "/v1/checkin", payload, headers: owner }))
        .statusCode,
    ).toBe(403);
    const staff = { authorization: `Bearer ${await token(newId(), ["staff"])}` };
    const checked = await app.inject({
      method: "POST",
      url: "/v1/checkin",
      payload,
      headers: staff,
    });
    expect(checked.json()).toMatchObject({ result: "ACCEPTED" });
    const jwks = (await app.inject({ url: "/.well-known/jwks.json" })).json();
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });
});
